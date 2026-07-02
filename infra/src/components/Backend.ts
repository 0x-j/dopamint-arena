import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendOutputs {
  taskDefinition: aws.ecs.TaskDefinition;
  taskDefinitionArn: pulumi.Output<string>;
  migrationTaskDefinition: aws.ecs.TaskDefinition;
  migrationTaskDefinitionArn: pulumi.Output<string>;
}

export interface BackendArgs {
  name: string;
  repositoryUrl: pulumi.Input<string>;
  imageTag: pulumi.Input<string>;
  pubSubEndpoint: pulumi.Input<string>;
  cacheEndpoint: pulumi.Input<string>;
  taskExecutionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
  // Secrets Manager ARN holding the base64 ed25519 settler key, injected as
  // SUI_SETTLER_KEY via ECS `secrets`. Omitted => the env var is simply absent.
  settlerKeySecretArn?: pulumi.Input<string>;
  // Secrets Manager ARN for the internal-faucet bearer token, injected as FAUCET_ADMIN_TOKEN
  // via ECS `secrets`. Omitted => POST /v1/faucet/internal stays disabled (503).
  faucetAdminTokenSecretArn?: pulumi.Input<string>;
  // Secrets Manager ARN for the Enoki PRIVATE api key, injected as ENOKI_API_KEY via ECS
  // `secrets`. Omitted => Enoki sponsorship is off and the settler is the sole gas source.
  enokiApiKeySecretArn?: pulumi.Input<string>;
  // Secrets Manager ARN for the wallet-pool passphrase (PR #124), injected as WALLET_POOL_ACCESS_VALUE
  // via ECS `secrets`. Omitted => the pool can't open and the arena opener degrades to Noop.
  walletPoolAccessSecretArn?: pulumi.Input<string>;
  // Ollama sidecar for the chat-v2 feature. Defaults off so existing tests and
  // small environments keep the current 1024/2048 task size.
  ollamaEnabled?: pulumi.Input<boolean>;
  // Model to pull and proxy (e.g. qwen2.5:1.5b). Only used when ollamaEnabled.
  ollamaModel?: pulumi.Input<string>;
  // Tag of the ollama/ollama image to run as the sidecar.
  ollamaImageTag?: pulumi.Input<string>;
  // Comma-separated list of origins allowed by the CORS layer. Omitted => permissive CORS.
  corsAllowedOrigins?: pulumi.Input<string>;
  // S3 bucket for transcript archival. Injected as S3_TRANSCRIPTS_BUCKET plaintext env.
  // Omitted => archival disabled.
  s3TranscriptsBucket?: pulumi.Input<string>;
}

function makeContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  const repositoryUrl = pulumi.output(args.repositoryUrl);
  const imageTag = pulumi.output(args.imageTag);
  const logGroupName = pulumi.output(args.logGroupName);
  // Bundle the three secret ARNs into one Output so the outer pulumi.all stays an 8-tuple
  // (its typed overloads stop at 8) — same reason the ollama trio is bundled below.
  const secretArns = pulumi
    .all([
      pulumi.output(args.settlerKeySecretArn ?? undefined),
      pulumi.output(args.faucetAdminTokenSecretArn ?? undefined),
      pulumi.output(args.enokiApiKeySecretArn ?? undefined),
      pulumi.output(args.walletPoolAccessSecretArn ?? undefined),
    ])
    .apply(([settler, faucetAdminToken, enoki, walletPoolAccess]) => ({
      settler,
      faucetAdminToken,
      enoki,
      walletPoolAccess,
    }));
  const corsAllowedOrigins = pulumi.output(
    args.corsAllowedOrigins ?? undefined,
  );
  const ollama = pulumi
    .all([
      pulumi.output(args.ollamaEnabled ?? false),
      pulumi.output(args.ollamaModel ?? "qwen2.5:1.5b"),
      pulumi.output(args.ollamaImageTag ?? "0.6.2"),
    ])
    .apply(([enabled, model, imageTag]) => ({ enabled, model, imageTag }));
  // Bundle the two Redis endpoints (related) so the outer tuple stays at 8 typed slots.
  const redis = pulumi
    .all([
      pulumi.output(args.pubSubEndpoint),
      pulumi.output(args.cacheEndpoint),
    ])
    .apply(([pubsub, cache]) => ({ pubsub, cache }));
  const s3Cfg = pulumi
    .all([pulumi.output(args.s3TranscriptsBucket ?? undefined)])
    .apply(([bucket]) => ({ bucket }));

  return pulumi
    .all([
      repositoryUrl,
      imageTag,
      redis,
      logGroupName,
      secretArns,
      corsAllowedOrigins,
      ollama,
      s3Cfg,
    ])
    .apply(
      ([
        repositoryUrl,
        imageTag,
        redis,
        logGroupName,
        secretArns,
        corsAllowedOrigins,
        ollama,
        s3Cfg,
      ]) => {
        const {
          enabled: ollamaEnabled,
          model: ollamaModel,
          imageTag: ollamaImageTag,
        } = ollama;
        const backendEnv: Array<{ name: string; value: string }> = [
          {
            name: "REDIS_PUBSUB_URL",
            value: `rediss://${redis.pubsub}:6379`,
          },
          {
            name: "REDIS_CACHE_URL",
            value: `rediss://${redis.cache}:6379`,
          },
          {
            name: "SUI_RPC_URL",
            value: "https://fullnode.testnet.sui.io:443",
          },
          {
            name: "TUNNEL_PACKAGE_ID",
            value:
              "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b",
          },
          // Slim example-app packages whose ops the sponsor gas-funds when set.
          {
            name: "AGENT_ALLOWANCE_PACKAGE_ID",
            value:
              "0x36d982ffdcf89c709829650bd6b07128f505f41d8953f48658746291d5bfb679",
          },
          {
            name: "STREAMING_PAYMENT_PACKAGE_ID",
            value:
              "0xd879bc156d7494d49b837222a8ebb348694a0685267129a76bdc1789c63c1edb",
          },
          // The sponsor only gas-funds MTPS faucet mints + staked tunnel opens whose coin
          // type matches this; without it config defaults to 0x2::sui::SUI and /v1/sponsor 422s.
          // ADR-0023 admin-mint MTPS package — must own MTPS_ADMIN_CAP_ID below.
          {
            name: "TUNNEL_COIN_TYPE",
            value:
              "0xf62966a08ab983e10224012bace10d2189ee9af4d67f0640bacb1f6d561ec83b::mtps::MTPS",
          },
          // AdminCap the faucet signs admin_mint with (ADR-0023). Must be owned by the settler
          // key and belong to TUNNEL_COIN_TYPE's package; unset => both faucet routes 503.
          {
            name: "MTPS_ADMIN_CAP_ID",
            value:
              "0x097e56a11cee007f947a719ed82811f42f1a903d989e79a21ae5a3dc90a83aac",
          },
          {
            name: "WALRUS_PUBLISHER_URL",
            value: "https://publisher.walrus-testnet.walrus.space",
          },
          {
            name: "WALRUS_AGGREGATOR_URL",
            value: "https://aggregator.walrus-testnet.walrus.space",
          },
          ...(s3Cfg.bucket
            ? [
                { name: "S3_TRANSCRIPTS_BUCKET", value: s3Cfg.bucket },
                { name: "AWS_REGION", value: aws.config.region ?? "us-east-1" },
              ]
            : []),
          ...(corsAllowedOrigins
            ? [
                {
                  name: "CORS_ALLOWED_ORIGINS",
                  value: corsAllowedOrigins,
                },
              ]
            : []),
          // Co-located arena fleet (ADR-0027) + funded seat-B wallet pool (PR #124). UNCONDITIONAL —
          // unrelated to the Ollama sidecar below. COUNT x served-games <= WALLET_POOL_FUNDED_COUNT
          // (each match consumes one funded seat-B wallet). GAMES is the served-set gate. The pool also
          // needs WALLET_POOL_ACCESS_VALUE (Secrets Manager) + s3:GetObject on the task role; absent =>
          // the opener degrades to Noop. AWS_REGION is required for the in-container S3 SDK (ECS does
          // not auto-inject it); credentials still come from the task role.
          { name: "FLEET_COLOCATED_COUNT", value: "5000" },
          {
            name: "FLEET_COLOCATED_GAMES",
            value:
              "quantum_poker,bomb_it,chicken_cross,world_canvas,blackjack,tic_tac_toe,caro,battleship,regular_payments",
          },
          { name: "WALLET_POOL_ID", value: "wp_cjmok4DQgZDpAooCGNjmqg" },
          {
            name: "WALLET_POOL_S3_BUCKET",
            value: "dev-env-dopamint-wallet-pool",
          },
          { name: "WALLET_POOL_FUNDED_COUNT", value: "5000" },
          { name: "AWS_REGION", value: aws.config.region ?? "us-east-1" },
        ];

        if (ollamaEnabled) {
          backendEnv.push(
            { name: "OLLAMA_URL", value: "http://localhost:11434" },
            { name: "OLLAMA_MODEL", value: ollamaModel },
          );
        }

        // Secrets injected from Secrets Manager at launch — never inlined as plaintext env
        // (a task definition is readable via ecs:DescribeTaskDefinition / committed to git).
        const backendSecrets: Array<{ name: string; valueFrom: string }> = [];
        if (secretArns.settler) {
          backendSecrets.push({
            name: "SUI_SETTLER_KEY",
            valueFrom: secretArns.settler,
          });
        }
        if (secretArns.faucetAdminToken) {
          backendSecrets.push({
            name: "FAUCET_ADMIN_TOKEN",
            valueFrom: secretArns.faucetAdminToken,
          });
        }
        if (secretArns.enoki) {
          backendSecrets.push({
            name: "ENOKI_API_KEY",
            valueFrom: secretArns.enoki,
          });
        }
        if (secretArns.walletPoolAccess) {
          backendSecrets.push({
            name: "WALLET_POOL_ACCESS_VALUE",
            valueFrom: secretArns.walletPoolAccess,
          });
        }

        const backendContainer = {
          name: "backend",
          image: `${repositoryUrl}:${imageTag}`,
          essential: true,
          portMappings: [{ containerPort: 8080, protocol: "tcp" }],
          environment: backendEnv,
          ...(backendSecrets.length > 0 ? { secrets: backendSecrets } : {}),
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": aws.config.region ?? "us-east-1",
              "awslogs-stream-prefix": "backend",
            },
          },
          healthCheck: {
            command: [
              "CMD-SHELL",
              "curl -f http://localhost:8080/health/live || exit 1",
            ],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 60,
          },
          stopTimeout: 30,
        };

        const containers: unknown[] = [backendContainer];

        if (ollamaEnabled) {
          containers.push({
            name: "ollama",
            image: `ollama/ollama:${ollamaImageTag}`,
            essential: false,
            portMappings: [{ containerPort: 11434, protocol: "tcp" }],
            environment: [{ name: "OLLAMA_KEEP_ALIVE", value: "-1" }],
            // Override the image entrypoint so we can pull the model before serving.
            entryPoint: ["/bin/sh", "-c"],
            command: [
              `ollama serve & sleep 5 && ollama pull ${ollamaModel} && wait`,
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": aws.config.region ?? "us-east-1",
                "awslogs-stream-prefix": "ollama",
              },
            },
            healthCheck: {
              command: ["CMD-SHELL", "ollama list >/dev/null 2>&1 || exit 1"],
              interval: 30,
              timeout: 10,
              retries: 5,
              startPeriod: 180,
            },
            stopTimeout: 30,
          });
        }

        return JSON.stringify(containers);
      },
    );
}

function makeMigrationContainerDefinitions(
  args: BackendArgs,
): pulumi.Output<string> {
  const repositoryUrl = pulumi.output(args.repositoryUrl);
  const imageTag = pulumi.output(args.imageTag);
  const logGroupName = pulumi.output(args.logGroupName);

  return pulumi
    .all([repositoryUrl, imageTag, logGroupName])
    .apply(([repositoryUrl, imageTag, logGroupName]) => {
      return JSON.stringify([
        {
          name: "migrate",
          image: `${repositoryUrl}:${imageTag}`,
          essential: true,
          command: ["sh", "-c", "echo 'no migration required'"],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": aws.config.region ?? "us-east-1",
              "awslogs-stream-prefix": "migrate",
            },
          },
        },
      ]);
    });
}

export function createBackend(args: BackendArgs): BackendOutputs {
  const name = args.name;
  const containerDefinitions = makeContainerDefinitions(args);
  const migrationContainerDefinitions = makeMigrationContainerDefinitions(args);

  const ollamaEnabled = pulumi.output(args.ollamaEnabled ?? false);
  const taskCpu = ollamaEnabled.apply((enabled) => (enabled ? "2048" : "1024"));
  const taskMemory = ollamaEnabled.apply((enabled) =>
    enabled ? "4096" : "2048",
  );

  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-backend-td`, {
    family: `${name}-backend`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: taskCpu,
    memory: taskMemory,
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions,
  });

  const migrationTaskDefinition = new aws.ecs.TaskDefinition(
    `${name}-backend-migrate-td`,
    {
      family: `${name}-backend-migrate`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "1024",
      memory: "2048",
      runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
      },
      executionRoleArn: args.taskExecutionRoleArn,
      taskRoleArn: args.taskRoleArn,
      containerDefinitions: migrationContainerDefinitions,
    },
  );

  return {
    taskDefinition,
    taskDefinitionArn: taskDefinition.arn,
    migrationTaskDefinition,
    migrationTaskDefinitionArn: migrationTaskDefinition.arn,
  };
}

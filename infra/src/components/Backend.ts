import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendOutputs {
  taskDefinition: aws.ecs.TaskDefinition;
  taskDefinitionArn: pulumi.Output<string>;
  migrationTaskDefinition: aws.ecs.TaskDefinition;
  migrationTaskDefinitionArn: pulumi.Output<string>;
  migrationTaskDefinitionFamily: pulumi.Output<string>;
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
  // Ollama sidecar for the chat-v2 feature. Defaults off so existing tests and
  // small environments keep the current 1024/2048 task size.
  ollamaEnabled?: pulumi.Input<boolean>;
  // Model to pull and proxy (e.g. qwen2.5:1.5b). Only used when ollamaEnabled.
  ollamaModel?: pulumi.Input<string>;
  // Tag of the ollama/ollama image to run as the sidecar.
  ollamaImageTag?: pulumi.Input<string>;
  // Comma-separated list of origins allowed by the CORS layer. Omitted => permissive CORS.
  corsAllowedOrigins?: pulumi.Input<string>;
  // Secrets Manager ARN holding the Postgres DATABASE_URL (via RDS Proxy). Injected as
  // DATABASE_URL via ECS `secrets` so the tunnel-manager can use the `pending_s3_archive`
  // durable retry queue (ADR-0023). Omitted => the env var is absent (fire-and-forget).
  databaseUrlSecretArn?: pulumi.Input<string>;
  // S3 bucket for transcript archival. Injected as S3_TRANSCRIPTS_BUCKET plaintext env.
  // Omitted => archival disabled.
  s3TranscriptsBucket?: pulumi.Input<string>;
}

function makeContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  const repositoryUrl = pulumi.output(args.repositoryUrl);
  const imageTag = pulumi.output(args.imageTag);
  const logGroupName = pulumi.output(args.logGroupName);
  const settlerKeySecretArn = pulumi.output(
    args.settlerKeySecretArn ?? undefined,
  );
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
    .all([
      pulumi.output(args.databaseUrlSecretArn ?? undefined),
      pulumi.output(args.s3TranscriptsBucket ?? undefined),
    ])
    .apply(([dbArn, bucket]) => ({ dbArn, bucket }));

  return pulumi
    .all([
      repositoryUrl,
      imageTag,
      redis,
      logGroupName,
      settlerKeySecretArn,
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
        settlerKeySecretArn,
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
          // The sponsor only gas-funds MTPS faucet mints + staked tunnel opens whose coin
          // type matches this; without it config defaults to 0x2::sui::SUI and /v1/sponsor 422s.
          {
            name: "TUNNEL_COIN_TYPE",
            value:
              "0x62e31a8b5105c16c67936fe129e3db17e5977a8667a3464db583baa89c04272c::mtps::MTPS",
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
        ];

        if (ollamaEnabled) {
          backendEnv.push(
            { name: "OLLAMA_URL", value: "http://localhost:11434" },
            { name: "OLLAMA_MODEL", value: ollamaModel },
          );
        }

        const backendContainer = {
          name: "backend",
          image: `${repositoryUrl}:${imageTag}`,
          essential: true,
          portMappings: [{ containerPort: 8080, protocol: "tcp" }],
          environment: backendEnv,
          // Private key: injected from Secrets Manager, never inlined as plaintext env.
          ...(function () {
            const secs: { name: string; valueFrom: string }[] = [];
            if (settlerKeySecretArn)
              secs.push({
                name: "SUI_SETTLER_KEY",
                valueFrom: settlerKeySecretArn,
              });
            if (s3Cfg.dbArn)
              secs.push({ name: "DATABASE_URL", valueFrom: s3Cfg.dbArn });
            return secs.length ? { secrets: secs } : {};
          })(),
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
  databaseUrlSecretArn?: pulumi.Input<string>,
): pulumi.Output<string> {
  const repositoryUrl = pulumi.output(args.repositoryUrl);
  const imageTag = pulumi.output(args.imageTag);
  const logGroupName = pulumi.output(args.logGroupName);
  const dbSecretArn = pulumi.output(databaseUrlSecretArn ?? undefined);

  return pulumi
    .all([repositoryUrl, imageTag, logGroupName, dbSecretArn])
    .apply(([repositoryUrl, imageTag, logGroupName, dbSecretArn]) => {
      const baseContainer = {
        name: "migrate",
        image: `${repositoryUrl}:${imageTag}`,
        essential: true,
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroupName,
            "awslogs-region": aws.config.region ?? "us-east-1",
            "awslogs-stream-prefix": "migrate",
          },
        },
      };

      if (dbSecretArn) {
        return JSON.stringify([
          {
            ...baseContainer,
            command: ["/usr/local/bin/migrate"],
            secrets: [{ name: "DATABASE_URL", valueFrom: dbSecretArn }],
          },
        ]);
      }

      return JSON.stringify([
        {
          ...baseContainer,
          command: ["sh", "-c", "echo 'no migration required'"],
        },
      ]);
    });
}

export function createBackend(args: BackendArgs): BackendOutputs {
  const name = args.name;
  const containerDefinitions = makeContainerDefinitions(args);
  const migrationContainerDefinitions = makeMigrationContainerDefinitions(
    args,
    args.databaseUrlSecretArn,
  );

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
    migrationTaskDefinitionFamily: migrationTaskDefinition.family,
  };
}

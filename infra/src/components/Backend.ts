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
  // Ollama sidecar for the chat-v2 feature. Defaults off so existing tests and
  // small environments keep the current 1024/2048 task size.
  ollamaEnabled?: pulumi.Input<boolean>;
  // Model to pull and proxy (e.g. qwen2.5:1.5b). Only used when ollamaEnabled.
  ollamaModel?: pulumi.Input<string>;
  // Tag of the ollama/ollama image to run as the sidecar.
  ollamaImageTag?: pulumi.Input<string>;
  // Browser origins allowed to call Ollama directly (Ollama OLLAMA_ORIGINS). Only
  // relevant when the sidecar is reached directly (e.g., local debugging); the ALB no
  // longer exposes /api/*. Omitted => no CORS allow-list.
  ollamaOrigins?: pulumi.Input<string>;
  // Comma-separated list of origins allowed by the CORS layer. Omitted => permissive CORS.
  corsAllowedOrigins?: pulumi.Input<string>;
}

function makeContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  const repositoryUrl = pulumi.output(args.repositoryUrl);
  const imageTag = pulumi.output(args.imageTag);
  const pubSubEndpoint = pulumi.output(args.pubSubEndpoint);
  const cacheEndpoint = pulumi.output(args.cacheEndpoint);
  const logGroupName = pulumi.output(args.logGroupName);
  const settlerKeySecretArn = pulumi.output(
    args.settlerKeySecretArn ?? undefined,
  );
  const corsAllowedOrigins = pulumi.output(
    args.corsAllowedOrigins ?? undefined,
  );
  const ollamaEnabled = pulumi.output(args.ollamaEnabled ?? false);
  const ollamaModel = pulumi.output(args.ollamaModel ?? "qwen2.5:1.5b");
  const ollamaImageTag = pulumi.output(args.ollamaImageTag ?? "0.6.2");
  const ollamaOrigins = pulumi.output(args.ollamaOrigins ?? undefined);
  // pulumi.all's tuple overloads stop at 8 elements; bundling the ollama config
  // into one output keeps the outer all an 8-tuple, so it stays heterogeneously
  // typed (the boolean enabled flag alongside the string config) rather than
  // collapsing to the homogeneous-array overload that rejects the boolean.
  const ollama = pulumi
    .all([ollamaEnabled, ollamaModel, ollamaImageTag, ollamaOrigins])
    .apply(([enabled, model, imageTag, origins]) => ({
      enabled,
      model,
      imageTag,
      origins,
    }));

  return pulumi
    .all([
      repositoryUrl,
      imageTag,
      pubSubEndpoint,
      cacheEndpoint,
      logGroupName,
      settlerKeySecretArn,
      corsAllowedOrigins,
      ollama,
    ])
    .apply(
      ([
        repositoryUrl,
        imageTag,
        pubSubEndpoint,
        cacheEndpoint,
        logGroupName,
        settlerKeySecretArn,
        corsAllowedOrigins,
        ollama,
      ]) => {
        const {
          enabled: ollamaEnabled,
          model: ollamaModel,
          imageTag: ollamaImageTag,
          origins: ollamaOriginsCfg,
        } = ollama;
        const backendEnv: Array<{ name: string; value: string }> = [
          {
            name: "REDIS_PUBSUB_URL",
            value: `rediss://${pubSubEndpoint}:6379`,
          },
          {
            name: "REDIS_CACHE_URL",
            value: `rediss://${cacheEndpoint}:6379`,
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
          ...(settlerKeySecretArn
            ? {
                secrets: [
                  {
                    name: "SUI_SETTLER_KEY",
                    valueFrom: settlerKeySecretArn,
                  },
                ],
              }
            : {}),
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
            environment: [
              { name: "OLLAMA_KEEP_ALIVE", value: "-1" },
              ...(ollamaOriginsCfg
                ? [{ name: "OLLAMA_ORIGINS", value: ollamaOriginsCfg }]
                : []),
            ],
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
  return pulumi
    .all([args.repositoryUrl, args.imageTag, args.logGroupName])
    .apply(([repositoryUrl, imageTag, logGroupName]) =>
      JSON.stringify([
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
      ]),
    );
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

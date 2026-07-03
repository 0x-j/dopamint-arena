import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("dopamint");

export interface InfraConfig {
  environment: string;
  domain: string;
  backendDomain: string;
  route53ZoneId?: string;
  certificateArn?: string; // existing ACM certificate ARN (Cloudflare DNS scenario)
  corsAllowedOrigins?: string;
  dbInstanceClass: string;
  dbServerless: boolean;
  dbMinCapacity?: number;
  dbMaxCapacity?: number;
  cacheNodeType: string;
  // If omitted, the backend image tag is resolved from the latest deployed ECS task
  // definition at runtime. This lets `pulumi up` run locally without committing a
  // specific tag, while CI still pins an exact SHA via config on backend deploys.
  backendImageTag?: string;
  // Backend ECS service scaling. Defaults are min 2, max 10, CPU target 70%.
  backendMinCapacity?: number;
  backendMaxCapacity?: number;
  backendTargetCpu?: number;
  // base64 ed25519 settler signing key. Optional: the backend boots without it
  // (Phase 0) and fails loud at settler construction if absent. Sourced from secret
  // config so it lands in Secrets Manager, never in the task definition.
  settlerKey?: pulumi.Output<string>;
  // Bearer secret gating POST /v1/faucet/internal, injected as FAUCET_ADMIN_TOKEN. Secret
  // config => Secrets Manager => ECS `secrets`. Unset => the internal faucet stays disabled (503).
  faucetAdminToken?: pulumi.Output<string>;
  // Enoki PRIVATE api key (enoki_private_…), injected as ENOKI_API_KEY. Secret config =>
  // Secrets Manager => ECS `secrets`. Unset => Enoki off, settler is the sole gas source.
  enokiApiKey?: pulumi.Output<string>;
  // HS256 signing secret for the arena allocate session-JWT gate (B5), injected as
  // SESSION_JWT_SECRET. Secret config => Secrets Manager => ECS `secrets`. Unset => the gate stays
  // OFF (allocate unauthenticated). Set via `pulumi config set --secret dopamint:session-jwt-secret`.
  sessionJwtSecret?: pulumi.Output<string>;
  // Wallet-pool passphrase (PR #124), injected as WALLET_POOL_ACCESS_VALUE. Secret config =>
  // Secrets Manager => ECS `secrets`. Unset => the pool can't open and the arena opener degrades to
  // Noop (no funded seat-B). Set via `pulumi config set --secret dopamint:wallet-pool-access-value`.
  walletPoolAccessValue?: pulumi.Output<string>;
  // Ollama sidecar for the chat-v2 feature. Enabled by default; disable in envs
  // where chat is not needed or where you want to supply an external Ollama URL.
  ollamaEnabled: boolean;
  ollamaModel: string;
  ollamaImageTag: string;
}

export function getConfig(): InfraConfig {
  return {
    environment: config.require("environment"),
    domain: config.require("domain"),
    backendDomain: config.require("backend-domain"),
    route53ZoneId: config.get("route53-zone-id") || undefined,
    certificateArn: config.get("certificate-arn") || undefined,
    corsAllowedOrigins: config.get("cors-allowed-origins") || undefined,
    dbInstanceClass: config.require("db-instance-class"),
    dbServerless: config.requireBoolean("db-serverless"),
    dbMinCapacity: config.getNumber("db-min-capacity"),
    dbMaxCapacity: config.getNumber("db-max-capacity"),
    cacheNodeType: config.require("cache-node-type"),
    backendImageTag: config.get("backend-image-tag") ?? undefined,
    backendMinCapacity: config.getNumber("backend-min-capacity") ?? 2,
    backendMaxCapacity: config.getNumber("backend-max-capacity") ?? 10,
    backendTargetCpu: config.getNumber("backend-target-cpu") ?? 70,
    settlerKey: config.getSecret("settler-key"),
    faucetAdminToken: config.getSecret("faucet-admin-token"),
    enokiApiKey: config.getSecret("enoki-api-key"),
    sessionJwtSecret: config.getSecret("session-jwt-secret"),
    walletPoolAccessValue: config.getSecret("wallet-pool-access-value"),
    ollamaEnabled: config.getBoolean("ollama-enabled") ?? true,
    ollamaModel: config.get("ollama-model") ?? "qwen2.5:1.5b",
    ollamaImageTag: config.get("ollama-image-tag") ?? "0.6.2",
  };
}

/**
 * Resolve the backend image tag from the latest ACTIVE revision of the backend task
 * definition family. Used when `backendImageTag` is not set in Pulumi config so local
 * infra deploys default to "whatever is currently running" instead of a stale baseline.
 *
 * Throws if the task definition cannot be found or contains no usable image tag. In that
 * case the caller must set the tag explicitly:
 *   pulumi config set dopamint:backend-image-tag <sha>
 */
export function resolveBackendImageTag(
  environment: string,
): pulumi.Output<string> {
  const family = `dopamint-${environment}-backend`;
  const taskDef = aws.ecs.getTaskDefinitionOutput({ taskDefinition: family });
  return taskDef.containerDefinitions.apply((defsJson) => {
    const defs = JSON.parse(defsJson) as Array<{ image?: string }>;
    const image = defs[0]?.image ?? "";
    const tag = image.split(":").pop() ?? "";
    if (!tag) {
      throw new Error(
        `Could not resolve backend image tag from the latest task definition (family: ${family}). ` +
          `Either deploy the backend first, or set the tag explicitly with: ` +
          `pulumi config set dopamint:backend-image-tag <tag>`,
      );
    }
    return tag;
  });
}

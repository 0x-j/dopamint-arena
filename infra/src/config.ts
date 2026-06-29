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
  benchmarkInstanceType: string;
  benchmarkMinSize: number;
  benchmarkMaxSize: number;
  benchmarkImageVersion: string;
  // If omitted, the backend image tag is resolved from the latest deployed ECS task
  // definition at runtime. This lets `pulumi up` run locally without committing a
  // specific tag, while CI still pins an exact SHA via config on backend deploys.
  backendImageTag?: string;
  // base64 ed25519 settler signing key. Optional: the backend boots without it
  // (Phase 0) and fails loud at settler construction if absent. Sourced from secret
  // config so it lands in Secrets Manager, never in the task definition.
  settlerKey?: pulumi.Output<string>;
  // Ollama sidecar for the chat-v2 feature. Enabled by default; disable in envs
  // where chat is not needed or where you want to supply an external Ollama URL.
  ollamaEnabled: boolean;
  ollamaModel: string;
  ollamaImageTag: string;
  // Warning: Only relevant when Ollama is exposed directly. With the backend-proxy
  // architecture, this should remain unset in deployed stacks.
  // Comma-separated browser origins allowed to call Ollama directly
  // (Ollama OLLAMA_ORIGINS). Only relevant for direct sidecar access (e.g., local
  // debugging); the ALB no longer exposes /api/*. Omit to keep Ollama private
  // (only reachable from within the backend task).
  ollamaOrigins?: string;
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
    benchmarkInstanceType: config.require("benchmark-instance-type"),
    benchmarkMinSize: config.requireNumber("benchmark-min-size"),
    benchmarkMaxSize: config.requireNumber("benchmark-max-size"),
    benchmarkImageVersion: config.get("benchmark-image-version") ?? "1.0.1",
    backendImageTag: config.get("backend-image-tag") ?? undefined,
    settlerKey: config.getSecret("settler-key"),
    ollamaEnabled: config.getBoolean("ollama-enabled") ?? true,
    ollamaModel: config.get("ollama-model") ?? "qwen2.5:1.5b",
    ollamaImageTag: config.get("ollama-image-tag") ?? "0.6.2",
    ollamaOrigins: config.get("ollama-origins") || undefined,
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

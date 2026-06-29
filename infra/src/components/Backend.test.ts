import { describe, it } from "node:test";
import assert from "node:assert";
import * as pulumi from "@pulumi/pulumi";
import { createBackend, type BackendArgs } from "./Backend.js";

async function awaitOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return (output as unknown as { promise(): Promise<T> }).promise();
}

function makeBackendArgs(overrides: Partial<BackendArgs> = {}): BackendArgs {
  return {
    name: "test",
    repositoryUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com/test",
    imageTag: "abc123",
    pubSubEndpoint: "pubsub.host",
    cacheEndpoint: "cache.host",
    taskExecutionRoleArn: "arn:aws:iam::123:role/exec",
    taskRoleArn: "arn:aws:iam::123:role/task",
    logGroupName: "/ecs/test",
    settlerKeySecretArn:
      "arn:aws:secretsmanager:us-east-1:123:secret:test-settler-AbCdEf",
    ...overrides,
  };
}

describe("backend component", () => {
  it("uses the configured image tag and exposes /health/live", async () => {
    const backend = createBackend(makeBackendArgs());

    const defs = JSON.parse(
      await awaitOutput(backend.taskDefinition.containerDefinitions),
    );
    const container = defs[0];

    assert.ok(
      container.image.endsWith(":abc123"),
      "image tag must match configured SHA",
    );
    assert.ok(
      container.healthCheck.command.some((c: string) =>
        c.includes("/health/live"),
      ),
      "liveness probe must target /health/live",
    );
    assert.strictEqual(container.stopTimeout, 30);
    assert.ok(
      container.environment.some(
        (e: { name: string }) => e.name === "REDIS_PUBSUB_URL",
      ),
      "must receive REDIS_PUBSUB_URL",
    );
    assert.ok(
      container.environment.some(
        (e: { name: string }) => e.name === "REDIS_CACHE_URL",
      ),
      "must receive REDIS_CACHE_URL",
    );

    // The settler signing key is a private key: it must be injected from Secrets
    // Manager, never baked into the task definition as plaintext (readable via
    // ecs:DescribeTaskDefinition and committed to git if hardcoded).
    assert.ok(
      !container.environment.some(
        (e: { name: string }) => e.name === "SUI_SETTLER_KEY",
      ),
      "settler key must never be a plaintext environment variable",
    );
    const settlerSecret = container.secrets?.find(
      (s: { name: string }) => s.name === "SUI_SETTLER_KEY",
    );
    assert.ok(
      settlerSecret,
      "settler key must be injected via secrets[] from Secrets Manager",
    );
    assert.strictEqual(
      settlerSecret.valueFrom,
      "arn:aws:secretsmanager:us-east-1:123:secret:test-settler-AbCdEf",
      "settler key valueFrom must reference the secret ARN",
    );

    assert.strictEqual(
      await awaitOutput(backend.taskDefinition.family),
      "test-backend",
    );
    assert.strictEqual(
      await awaitOutput(backend.taskDefinition.networkMode),
      "awsvpc",
    );
    assert.deepStrictEqual(
      await awaitOutput(backend.taskDefinition.requiresCompatibilities),
      ["FARGATE"],
    );
    assert.strictEqual(await awaitOutput(backend.taskDefinition.cpu), "1024");
    assert.strictEqual(
      await awaitOutput(backend.taskDefinition.memory),
      "2048",
    );
  });

  it("runs a no-op migration container", async () => {
    const backend = createBackend(makeBackendArgs());

    const defs = JSON.parse(
      await awaitOutput(backend.migrationTaskDefinition.containerDefinitions),
    );
    const container = defs[0];

    assert.ok(
      container.command.some((c: string) =>
        c.includes("no migration required"),
      ),
      "migration must be a no-op",
    );
    assert.ok(
      !container.environment?.some(
        (e: { name: string }) => e.name === "DATABASE_URL",
      ),
      "migration must not receive DATABASE_URL",
    );
  });

  it("omits the settler secret when no ARN is configured, never falling back to plaintext", async () => {
    const backend = createBackend(
      makeBackendArgs({ settlerKeySecretArn: undefined }),
    );

    const defs = JSON.parse(
      await awaitOutput(backend.taskDefinition.containerDefinitions),
    );
    const container = defs[0];

    assert.ok(
      !container.environment.some(
        (e: { name: string }) => e.name === "SUI_SETTLER_KEY",
      ),
      "settler key must never appear as plaintext env, even when the secret is unset",
    );
    assert.ok(
      !container.secrets?.some(
        (s: { name: string }) => s.name === "SUI_SETTLER_KEY",
      ),
      "no settler secret entry when the ARN is absent",
    );
  });

  it("does not include an Ollama sidecar by default", async () => {
    const backend = createBackend(makeBackendArgs());

    const defs = JSON.parse(
      await awaitOutput(backend.taskDefinition.containerDefinitions),
    );

    assert.strictEqual(
      defs.find((c: { name: string }) => c.name === "ollama"),
      undefined,
      "ollama container must not be present by default",
    );
    const backendEnv = defs[0].environment;
    assert.ok(
      !backendEnv.some((e: { name: string }) => e.name === "OLLAMA_URL"),
      "OLLAMA_URL must not be set when sidecar is disabled",
    );
    assert.strictEqual(await awaitOutput(backend.taskDefinition.cpu), "1024");
    assert.strictEqual(
      await awaitOutput(backend.taskDefinition.memory),
      "2048",
    );
  });

  it("adds an Ollama sidecar and scales the task when enabled", async () => {
    const backend = createBackend(
      makeBackendArgs({
        ollamaEnabled: true,
        ollamaModel: "qwen2.5:1.5b",
        ollamaImageTag: "0.6.2",
      }),
    );

    const defs = JSON.parse(
      await awaitOutput(backend.taskDefinition.containerDefinitions),
    );
    const backendContainer = defs.find(
      (c: { name: string }) => c.name === "backend",
    );
    const ollamaContainer = defs.find(
      (c: { name: string }) => c.name === "ollama",
    );

    assert.ok(ollamaContainer, "ollama container must be present");
    assert.ok(
      ollamaContainer.image.startsWith("ollama/ollama:"),
      "ollama image must use the ollama registry",
    );
    assert.ok(
      ollamaContainer.command.some((c: string) => c.includes("qwen2.5:1.5b")),
      "ollama command must pull the configured model",
    );
    assert.ok(
      backendContainer.environment.some(
        (e: { name: string; value: string }) =>
          e.name === "OLLAMA_URL" && e.value === "http://localhost:11434",
      ),
      "backend must point OLLAMA_URL at the sidecar",
    );
    assert.ok(
      backendContainer.environment.some(
        (e: { name: string; value: string }) =>
          e.name === "OLLAMA_MODEL" && e.value === "qwen2.5:1.5b",
      ),
      "backend must receive the configured OLLAMA_MODEL",
    );
    assert.strictEqual(await awaitOutput(backend.taskDefinition.cpu), "2048");
    assert.strictEqual(
      await awaitOutput(backend.taskDefinition.memory),
      "4096",
    );
  });

  it("wires S3 transcript archival and the DATABASE_URL secret when configured", async () => {
    const backend = createBackend(
      makeBackendArgs({
        databaseUrlSecretArn:
          "arn:aws:secretsmanager:us-east-1:123:secret:test-db-url-AbCdEf",
        s3TranscriptsBucket: "dopamint-test-transcripts",
      }),
    );

    const defs = JSON.parse(
      await awaitOutput(backend.taskDefinition.containerDefinitions),
    );
    const container = defs[0];
    const backendEnv = container.environment;

    const s3BucketEnv = backendEnv.find(
      (e: { name: string }) => e.name === "S3_TRANSCRIPTS_BUCKET",
    );
    assert.ok(s3BucketEnv, "must receive S3_TRANSCRIPTS_BUCKET");
    assert.strictEqual(
      s3BucketEnv.value,
      "dopamint-test-transcripts",
      "S3_TRANSCRIPTS_BUCKET must reference the configured bucket",
    );
    assert.ok(
      backendEnv.some((e: { name: string }) => e.name === "AWS_REGION"),
      "must receive AWS_REGION for S3 SDK",
    );

    assert.ok(
      !backendEnv.some((e: { name: string }) => e.name === "DATABASE_URL"),
      "DATABASE_URL must never be a plaintext environment variable",
    );
    const dbSecret = container.secrets?.find(
      (s: { name: string }) => s.name === "DATABASE_URL",
    );
    assert.ok(
      dbSecret,
      "DATABASE_URL must be injected via secrets[] from Secrets Manager",
    );
    assert.strictEqual(
      dbSecret.valueFrom,
      "arn:aws:secretsmanager:us-east-1:123:secret:test-db-url-AbCdEf",
      "DATABASE_URL valueFrom must reference the secret ARN",
    );
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { setAllConfig } from "@pulumi/pulumi/runtime/config.js";
import { getConfig } from "./config.js";

function setPulumiConfig(
  config: Record<string, string>,
  secrets: string[] = [],
) {
  setAllConfig(config, secrets);
}

function clearPulumiConfig() {
  setAllConfig({}, []);
}

const baseConfig: Record<string, string> = {
  "dopamint:environment": "test",
  "dopamint:domain": "test.example",
  "dopamint:backend-domain": "api.test.example",
  "dopamint:db-instance-class": "db.t3.medium",
  "dopamint:db-serverless": "false",
  "dopamint:cache-node-type": "cache.t3.micro",
};

describe("config", () => {
  afterEach(() => {
    clearPulumiConfig();
  });

  it("reads required environment config", () => {
    setPulumiConfig({
      ...baseConfig,
      "dopamint:backend-image-tag": "test-sha",
    });

    const cfg = getConfig();

    assert.strictEqual(cfg.environment, "test");
    assert.strictEqual(cfg.domain, "test.example");
    assert.strictEqual(cfg.backendDomain, "api.test.example");
    assert.strictEqual(cfg.dbInstanceClass, "db.t3.medium");
    assert.strictEqual(cfg.dbServerless, false);
    assert.strictEqual(cfg.cacheNodeType, "cache.t3.micro");
    assert.strictEqual(cfg.backendImageTag, "test-sha");
    assert.strictEqual(cfg.sponsorSenderWindowSecs, 60);
    assert.strictEqual(cfg.sponsorSenderMaxPerWindow, 120);
    assert.strictEqual(cfg.sponsorGlobalDailyLimit, 100_000);
  });

  it("reads sponsor limit overrides", () => {
    setPulumiConfig({
      ...baseConfig,
      "dopamint:sponsor-sender-window-secs": "30",
      "dopamint:sponsor-sender-max-per-window": "7",
      "dopamint:sponsor-global-daily-limit": "99",
    });

    const cfg = getConfig();

    assert.strictEqual(cfg.sponsorSenderWindowSecs, 30);
    assert.strictEqual(cfg.sponsorSenderMaxPerWindow, 7);
    assert.strictEqual(cfg.sponsorGlobalDailyLimit, 99);
  });

  it("leaves backend image tag unset for live resolution", () => {
    setPulumiConfig(baseConfig);

    const cfg = getConfig();

    assert.strictEqual(cfg.backendImageTag, undefined);
  });

  // The settler key is sourced from secret config (never hardcoded), so it can be
  // wired into Secrets Manager instead of the task definition.
  it("exposes the settler key from secret config", async () => {
    setPulumiConfig(
      {
        ...baseConfig,
        "dopamint:backend-image-tag": "test-sha",
        "dopamint:settler-key": "test-settler-key",
      },
      ["dopamint:settler-key"],
    );

    const cfg = getConfig();

    assert.ok(cfg.settlerKey, "settler key must be read from secret config");
    const value = await (
      cfg.settlerKey as unknown as { promise(): Promise<string> }
    ).promise();
    assert.strictEqual(value, "test-settler-key");
  });
});

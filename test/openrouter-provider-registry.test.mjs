import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function listedModel({
  slug,
  gatewayModel,
  upstreamModel,
  displayName,
  compHash,
  provider = "openrouter",
}) {
  return {
    slug,
    gatewayModel,
    upstreamModel,
    provider,
    listed: true,
    displayName,
    description: `${displayName} test route.`,
    priority: 100,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
    contextWindow: 131072,
    autoCompact: 100000,
    inputModalities: ["text"],
    compHash,
  };
}

function readRegistry({ variants, userModels = [], registryPath } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "openrouter-registry-"));
  writeFileSync(path.join(stateDir, "openrouter-provider-variants.json"), JSON.stringify({
    version: 2,
    variants,
  }));
  writeFileSync(path.join(stateDir, "user-models.json"), JSON.stringify({
    version: 1,
    models: userModels,
  }));
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const r = await import('./src/model-registry.mjs'); process.stdout.write(JSON.stringify({models:r.MODELS,warnings:r.USER_MODEL_WARNINGS}));",
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODEX_ROUTER_STATE_DIR: stateDir,
      ...(registryPath ? { MODEL_ROUTER_REGISTRY: registryPath } : {}),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("checked-in OpenRouter bases materialize selected routes without changing Automatic", () => {
  const baseModel = "openrouter/deepseek-v4.1-flash";
  const result = readRegistry({
    variants: [{
      baseModel,
      providerOrder: [{ providerSlug: "deepinfra", providerName: "DeepInfra" }],
      allowFallbacks: true,
    }],
  });
  const automatic = result.models.find((model) => model.slug === baseModel);
  const variant = result.models.find((model) => model.slug === `${baseModel}-via-deepinfra`);
  assert.ok(automatic);
  assert.equal(automatic.openrouterRouting, undefined);
  assert.ok(variant);
  assert.equal(variant.upstreamModel, automatic.upstreamModel);
  assert.equal(variant.multiAgentVersion, "v1");
  assert.deepEqual(variant.openrouterRouting.providerOrder, [{
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
  }]);
});

test("user-curated OpenRouter bases can materialize provider variants", () => {
  const base = listedModel({
    slug: "openrouter/custom-model",
    gatewayModel: "openrouter-custom-model",
    upstreamModel: "vendor/custom-model",
    displayName: "Custom Model (OpenRouter)",
    compHash: "custom-model-v1",
  });
  const result = readRegistry({
    userModels: [base],
    variants: [{
      baseModel: base.slug,
      providerOrder: [{ providerSlug: "together", providerName: "Together" }],
      allowFallbacks: false,
    }],
  });
  const variant = result.models.find((model) => model.slug === "openrouter/custom-model-via-together");
  assert.ok(variant);
  assert.equal(variant.upstreamModel, "vendor/custom-model");
  assert.equal(variant.displayName, "Custom Model (OpenRouter · Together only)");
  assert.equal(variant.openrouterRouting.allowFallbacks, false);
});

test("derived identifier collisions leave the selection inactive and diagnostic", () => {
  const collision = listedModel({
    slug: "openrouter/deepseek-v4.1-flash-via-deepinfra",
    gatewayModel: "openrouter-unrelated-collision",
    upstreamModel: "vendor/unrelated-model",
    displayName: "Unrelated Collision (OpenRouter)",
    compHash: "collision-v1",
  });
  const result = readRegistry({
    userModels: [collision],
    variants: [{
      baseModel: "openrouter/deepseek-v4.1-flash",
      providerOrder: [{ providerSlug: "deepinfra", providerName: "DeepInfra" }],
      allowFallbacks: true,
    }],
  });
  assert.equal(
    result.models.filter((model) => model.slug === collision.slug).length,
    1,
  );
  assert.match(result.warnings.join("\n"), /Inactive OpenRouter provider variant.*duplicate model slug/);
});

test("a removed base preserves inactive state and surfaces a diagnostic", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openrouter-registry-override-"));
  const registryPath = path.join(directory, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    providers: [{
      id: "openrouter",
      displayName: "OpenRouter",
      kind: "openai-compatible",
      ownedBy: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      credential: { environment: ["OPENROUTER_API_KEY"], file: "openrouter-api-key.secret" },
    }],
    models: [listedModel({
      slug: "openrouter/other-model",
      gatewayModel: "openrouter-other-model",
      upstreamModel: "vendor/other-model",
      displayName: "Other Model (OpenRouter)",
      compHash: "other-v1",
    })],
  }));
  const missing = "openrouter/deepseek-v4.1-flash";
  const result = readRegistry({
    registryPath,
    variants: [{
      baseModel: missing,
      providerOrder: [{ providerSlug: "deepinfra", providerName: "DeepInfra" }],
      allowFallbacks: true,
    }],
  });
  assert.equal(result.models.some((model) => model.slug === `${missing}-via-deepinfra`), false);
  assert.match(result.warnings.join("\n"), /base model is unavailable/);
});

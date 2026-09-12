import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeOpenRouterProviderVariant,
  openRouterVariantIdentity,
  readOpenRouterProviderVariants,
  replaceOpenRouterProviderVariants,
  writeOpenRouterProviderVariants,
} from "../src/openrouter-provider-variants.mjs";

function provider(providerSlug = "deepinfra", providerName = "DeepInfra") {
  return { providerSlug, providerName };
}

function selection(providerOrder = [provider()]) {
  return {
    baseModel: "openrouter/deepseek-v4.1-flash",
    providerOrder,
    allowFallbacks: true,
  };
}

function baseModel(overrides = {}) {
  return {
    slug: "openrouter/deepseek-v4.1-flash",
    gatewayModel: "openrouter-deepseek-v4-1-flash",
    upstreamModel: "deepseek/deepseek-v4.1-flash",
    provider: "openrouter",
    listed: true,
    displayName: "DeepSeek V4.1 Flash (OpenRouter)",
    description: "DeepSeek through OpenRouter.",
    priority: 74,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
    contextWindow: 1_048_576,
    autoCompact: 900_000,
    inputModalities: ["text", "image"],
    requestProfile: "auto-tool-choice",
    compHash: "base-v1",
    multiAgentVersion: "v2",
    subagentVerifiedLocally: true,
    ...overrides,
  };
}

test("provider chain state is private, versioned, ordered, and contains no endpoint data", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openrouter-variants-"));
  const filePath = path.join(directory, "variants.json");
  writeOpenRouterProviderVariants([
    selection(),
    { ...selection([provider("fireworks", "Fireworks")]), baseModel: "openrouter/glm-5.3-flash" },
  ], filePath);
  replaceOpenRouterProviderVariants(
    "openrouter/deepseek-v4.1-flash",
    {
      providerOrder: [provider("together", "Together"), provider("deepinfra", "DeepInfra")],
      allowFallbacks: false,
    },
    filePath,
  );
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.variants, [
    {
      baseModel: "openrouter/deepseek-v4.1-flash",
      providerOrder: [
        provider("together", "Together"),
        provider("deepinfra", "DeepInfra"),
      ],
      allowFallbacks: false,
    },
    {
      baseModel: "openrouter/glm-5.3-flash",
      providerOrder: [provider("fireworks", "Fireworks")],
      allowFallbacks: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /api[_-]?key|https?:|pricing|health/i);
});

test("legacy independent variants migrate conservatively into one visible ordered chain", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openrouter-variants-legacy-"));
  const filePath = path.join(directory, "variants.json");
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    variants: [
      {
        baseModel: "openrouter/deepseek-v4.1-flash",
        providerSlug: "deepinfra",
        providerName: "DeepInfra",
        allowFallbacks: true,
      },
      {
        baseModel: "openrouter/deepseek-v4.1-flash",
        providerSlug: "together",
        providerName: "Together",
        allowFallbacks: false,
      },
    ],
  }));
  const state = readOpenRouterProviderVariants(filePath);
  assert.equal(state.invalid, false);
  assert.equal(state.sourceVersion, 1);
  assert.deepEqual(state.variants, [{
    baseModel: "openrouter/deepseek-v4.1-flash",
    providerOrder: [provider(), provider("together", "Together")],
    allowFallbacks: false,
  }]);
  assert.match(state.warnings.join("\n"), /combined in their stored order/);
});

test("unsafe, malformed, duplicate, and invalid fallback policy state fails closed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openrouter-variants-invalid-"));
  const malformed = path.join(directory, "malformed.json");
  writeFileSync(malformed, JSON.stringify({
    version: 2,
    variants: [selection([provider(), provider()])],
  }));
  assert.equal(readOpenRouterProviderVariants(malformed).invalid, true);

  const invalidPolicy = path.join(directory, "invalid-policy.json");
  writeFileSync(invalidPolicy, JSON.stringify({
    version: 2,
    variants: [{ ...selection(), allowFallbacks: "sometimes" }],
  }));
  assert.equal(readOpenRouterProviderVariants(invalidPolicy).invalid, true);

  const link = path.join(directory, "linked.json");
  symlinkSync(malformed, link);
  assert.equal(readOpenRouterProviderVariants(link).invalid, true);
  assert.throws(
    () => replaceOpenRouterProviderVariants("openrouter/deepseek-v4.1-flash", undefined, malformed),
    /refusing to overwrite/,
  );
});

test("materialization preserves provider priority and excludes native subagent certification", () => {
  const ordered = selection([
    provider("deepinfra", "DeepInfra"),
    provider("fireworks", "Fireworks"),
  ]);
  const variant = materializeOpenRouterProviderVariant(baseModel(), ordered);
  assert.equal(variant.slug, "openrouter/deepseek-v4.1-flash-via-deepinfra");
  assert.equal(variant.gatewayModel, "openrouter-deepseek-v4-1-flash-via-deepinfra");
  assert.equal(variant.upstreamModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(
    variant.displayName,
    "DeepSeek V4.1 Flash (OpenRouter · DeepInfra → Fireworks → Automatic)",
  );
  assert.equal(variant.requestProfile, "auto-tool-choice");
  assert.deepEqual(variant.inputModalities, ["text", "image"]);
  assert.equal(variant.multiAgentVersion, "v1");
  assert.equal(variant.subagentVerifiedLocally, undefined);
  assert.notEqual(variant.compHash, baseModel().compHash);
  assert.deepEqual(variant.openrouterRouting, ordered);
});

test("strict materialization has a distinct compatibility hash and truthful picker copy", () => {
  const preferred = materializeOpenRouterProviderVariant(baseModel(), selection());
  const strict = materializeOpenRouterProviderVariant(baseModel(), {
    ...selection(),
    allowFallbacks: false,
  });
  assert.equal(strict.slug, preferred.slug);
  assert.notEqual(strict.compHash, preferred.compHash);
  assert.equal(strict.displayName, "DeepSeek V4.1 Flash (OpenRouter · DeepInfra only)");
  assert.match(strict.description, /restricted to DeepInfra, in that order/);
  assert.equal(strict.openrouterRouting.allowFallbacks, false);
});

test("derived identifiers are bounded and deterministic from the first provider", () => {
  assert.deepEqual(openRouterVariantIdentity(baseModel(), [provider()]), {
    slug: "openrouter/deepseek-v4.1-flash-via-deepinfra",
    gatewayModel: "openrouter-deepseek-v4-1-flash-via-deepinfra",
  });
  assert.throws(
    () => openRouterVariantIdentity(
      baseModel({ slug: `openrouter/${"x".repeat(180)}` }),
      [provider()],
    ),
    /invalid or oversized/,
  );
});

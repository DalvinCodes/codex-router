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

function selection(providerSlug = "deepinfra", providerName = "DeepInfra") {
  return {
    baseModel: "openrouter/deepseek-v4.1-flash",
    providerSlug,
    providerName,
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

test("provider variant state is private, versioned, replaceable per base model, and contains no endpoint data", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openrouter-variants-"));
  const filePath = path.join(directory, "variants.json");
  writeOpenRouterProviderVariants([
    selection(),
    { ...selection("fireworks", "Fireworks"), baseModel: "openrouter/glm-5.3-flash" },
  ], filePath);
  replaceOpenRouterProviderVariants(
    "openrouter/deepseek-v4.1-flash",
    [{ providerSlug: "together", providerName: "Together" }],
    filePath,
  );
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.variants, [
    {
      baseModel: "openrouter/deepseek-v4.1-flash",
      providerSlug: "together",
      providerName: "Together",
      allowFallbacks: true,
    },
    {
      baseModel: "openrouter/glm-5.3-flash",
      providerSlug: "fireworks",
      providerName: "Fireworks",
      allowFallbacks: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /api[_-]?key|https?:|pricing|health/i);
});

test("unsafe, malformed, duplicate, and strict-only variant state fails closed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openrouter-variants-invalid-"));
  const malformed = path.join(directory, "malformed.json");
  writeFileSync(malformed, JSON.stringify({ version: 1, variants: [selection(), selection()] }));
  assert.equal(readOpenRouterProviderVariants(malformed).invalid, true);

  const strict = path.join(directory, "strict.json");
  writeFileSync(strict, JSON.stringify({
    version: 1,
    variants: [{ ...selection(), allowFallbacks: false }],
  }));
  assert.equal(readOpenRouterProviderVariants(strict).invalid, true);

  const link = path.join(directory, "linked.json");
  symlinkSync(malformed, link);
  assert.equal(readOpenRouterProviderVariants(link).invalid, true);
  assert.throws(
    () => replaceOpenRouterProviderVariants("openrouter/deepseek-v4.1-flash", [], malformed),
    /refusing to overwrite/,
  );
});

test("materialization inherits model behavior but not native or local subagent certification", () => {
  const variant = materializeOpenRouterProviderVariant(baseModel(), selection());
  assert.equal(variant.slug, "openrouter/deepseek-v4.1-flash-via-deepinfra");
  assert.equal(variant.gatewayModel, "openrouter-deepseek-v4-1-flash-via-deepinfra");
  assert.equal(variant.upstreamModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(variant.displayName, "DeepSeek V4.1 Flash (OpenRouter · DeepInfra preferred)");
  assert.equal(variant.requestProfile, "auto-tool-choice");
  assert.deepEqual(variant.inputModalities, ["text", "image"]);
  assert.equal(variant.multiAgentVersion, "v1");
  assert.equal(variant.subagentVerifiedLocally, undefined);
  assert.notEqual(variant.compHash, baseModel().compHash);
  assert.deepEqual(variant.openrouterRouting, {
    baseModel: "openrouter/deepseek-v4.1-flash",
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
    allowFallbacks: true,
  });
});

test("derived identifiers are bounded and deterministic", () => {
  assert.deepEqual(openRouterVariantIdentity(baseModel(), "deepinfra"), {
    slug: "openrouter/deepseek-v4.1-flash-via-deepinfra",
    gatewayModel: "openrouter-deepseek-v4-1-flash-via-deepinfra",
  });
  assert.throws(
    () => openRouterVariantIdentity(baseModel({ slug: `openrouter/${"x".repeat(180)}` }), "deepinfra"),
    /invalid or oversized/,
  );
});

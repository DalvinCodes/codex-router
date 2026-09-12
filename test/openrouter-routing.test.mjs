import assert from "node:assert/strict";
import test from "node:test";

import { applyOpenRouterProviderRouting } from "../src/openrouter-routing.mjs";

const variant = {
  provider: "openrouter",
  openrouterRouting: {
    baseModel: "openrouter/deepseek-v4.1-flash",
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
    allowFallbacks: true,
  },
};

test("Automatic OpenRouter requests do not gain a router-generated provider preference", () => {
  const payload = { model: "deepseek/deepseek-v4.1-flash", messages: [] };
  assert.equal(applyOpenRouterProviderRouting(payload, { provider: "openrouter" }, "/chat/completions"), false);
  assert.equal("provider" in payload, false);
});

test("an OpenRouter provider variant overrides inbound routing with preferred-with-fallback policy", () => {
  const payload = {
    model: "deepseek/deepseek-v4.1-flash",
    messages: [],
    provider: { order: ["attacker-choice"], allow_fallbacks: false },
  };
  assert.equal(applyOpenRouterProviderRouting(payload, variant, "/chat/completions"), true);
  assert.deepEqual(payload.provider, {
    order: ["deepinfra"],
    allow_fallbacks: true,
  });
});

test("routing metadata never leaks to other providers or unsupported surfaces", () => {
  for (const [model, route] of [
    [{ ...variant, provider: "deepseek" }, "/chat/completions"],
    [variant, "/embeddings"],
    [variant, "/responses"],
  ]) {
    const payload = { model: "unchanged", input: "hello" };
    assert.equal(applyOpenRouterProviderRouting(payload, model, route), false);
    assert.equal("provider" in payload, false);
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "openrouter-provider-discovery-"));
const original = {
  CODEX_ROUTER_STATE_DIR: process.env.CODEX_ROUTER_STATE_DIR,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_API_BASE_URL: process.env.OPENROUTER_API_BASE_URL,
};
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.OPENROUTER_API_KEY = "fixture-openrouter-key-a";
delete process.env.OPENROUTER_API_BASE_URL;

after(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const {
  discoverOpenRouterProviders,
  groupOpenRouterProviders,
  validateOpenRouterEndpointPayload,
} = await import("../src/openrouter-provider-discovery.mjs");
const {
  CATALOG_STALE_AFTER_MS,
} = await import("../src/model-catalog-cache.mjs");
const {
  writeOpenRouterProviderVariants,
} = await import("../src/openrouter-provider-variants.mjs");
const {
  OPENROUTER_PROVIDER_VARIANTS_PATH,
} = await import("../src/paths.mjs");

const PUBLIC_IP = "93.184.216.34";
const MODEL = "openrouter/deepseek-v4.1-flash";

function endpoint(tag, providerName, quantization = "fp16", status = 0) {
  return {
    tag,
    provider_name: providerName,
    quantization,
    status,
    model_id: "deepseek/deepseek-v4.1-flash",
  };
}

function payload(endpoints = [endpoint("deepinfra", "DeepInfra")]) {
  return {
    data: {
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      endpoints,
    },
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("endpoint schema validation groups provider tags, deduplicates endpoints, and reports availability", () => {
  const fixture = payload([
    endpoint("deepinfra/fp8", "DeepInfra", "fp8"),
    endpoint("deepinfra", "DeepInfra", "fp16"),
    endpoint("deepinfra/fp8", "DeepInfra", "fp8"),
    endpoint("fireworks", "Fireworks", "fp8", 1),
  ]);
  assert.equal(validateOpenRouterEndpointPayload(fixture).length, 4);
  assert.deepEqual(groupOpenRouterProviders(fixture), [
    {
      slug: "deepinfra",
      name: "DeepInfra",
      endpointCount: 2,
      quantizations: ["fp16", "fp8"],
      available: true,
    },
    {
      slug: "fireworks",
      name: "Fireworks",
      endpointCount: 1,
      quantizations: ["fp8"],
      available: false,
    },
  ]);
});

test("endpoint inventories reject malformed provider ids and bounded-record violations", () => {
  assert.throws(
    () => validateOpenRouterEndpointPayload(payload([endpoint("Deep Infra", "DeepInfra")])),
    /invalid provider identity/,
  );
  assert.throws(
    () => validateOpenRouterEndpointPayload(payload([endpoint("deepinfra/\u0000fp8", "DeepInfra")])),
    /invalid provider identity/,
  );
  assert.throws(
    () => validateOpenRouterEndpointPayload(payload([endpoint("deepinfra", "DeepInfra")]), { maxEndpoints: 0 }),
    /oversized endpoint inventory/,
  );
  assert.throws(
    () => validateOpenRouterEndpointPayload(payload([endpoint("deepinfra", "DeepInfra")]), { maxRecordBytes: 4 }),
    /invalid or oversized/,
  );
});

test("discovery uses the documented model endpoint and the credential-isolated bounded transport", async () => {
  let request;
  const result = await discoverOpenRouterProviders(MODEL, {
    cache: false,
    resolveHost: async () => [PUBLIC_IP],
    proxyResolvesDestination: false,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(payload([
        endpoint("deepinfra/fp8", "DeepInfra", "fp8"),
        endpoint("deepinfra", "DeepInfra", "fp16"),
      ]));
    },
  });
  assert.equal(
    request.url,
    "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints",
  );
  assert.equal(request.options.headers.Authorization, "Bearer fixture-openrouter-key-a");
  assert.equal(request.options.redirect, "manual");
  assert.equal(result.cached, false);
  assert.equal(result.stale, false);
  assert.equal(result.providers[0].slug, "deepinfra");
  assert.equal(result.providers[0].selected, false);
  assert.equal(result.providers[0].allowFallbacks, true);
});

test("cache entries are separated by model, base URL, and credential fingerprint and become stale after 24 hours", async () => {
  const cachePath = path.join(stateDir, "separation-cache.json");
  const started = Date.parse("2026-09-11T12:00:00.000Z");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(payload());
  };
  const options = {
    cachePath,
    now: started,
    resolveHost: async () => [PUBLIC_IP],
    proxyResolvesDestination: false,
    fetchImpl,
  };
  const first = await discoverOpenRouterProviders(MODEL, options);
  const cached = await discoverOpenRouterProviders(MODEL, options);
  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(readFileSync(cachePath, "utf8"), /fixture-openrouter-key-a/);
  if (process.platform !== "win32") assert.equal(statSync(cachePath).mode & 0o777, 0o600);

  const stale = await discoverOpenRouterProviders(MODEL, {
    ...options,
    now: started + CATALOG_STALE_AFTER_MS,
  });
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true);
  assert.equal(calls, 1, "stale cache is returned for the caller to refresh in the background");

  process.env.OPENROUTER_API_KEY = "fixture-openrouter-key-b";
  await discoverOpenRouterProviders(MODEL, options);
  assert.equal(calls, 2, "a different credential cannot reuse the first account's inventory");

  process.env.OPENROUTER_API_BASE_URL = "https://openrouter.example.test/api/v1";
  await discoverOpenRouterProviders(MODEL, options);
  assert.equal(calls, 3, "a different base URL cannot reuse the first endpoint's inventory");
  delete process.env.OPENROUTER_API_BASE_URL;
  process.env.OPENROUTER_API_KEY = "fixture-openrouter-key-a";
});

test("refresh bypasses cache and selected withdrawn brands remain visible as unadvertised", async () => {
  writeOpenRouterProviderVariants([{
    baseModel: MODEL,
    providerSlug: "withdrawn-host",
    providerName: "Withdrawn Host",
    allowFallbacks: false,
  }], OPENROUTER_PROVIDER_VARIANTS_PATH);
  let calls = 0;
  const result = await discoverOpenRouterProviders(MODEL, {
    refresh: true,
    cache: false,
    resolveHost: async () => [PUBLIC_IP],
    proxyResolvesDestination: false,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(payload());
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.providers.find((provider) => provider.slug === "withdrawn-host"), {
    slug: "withdrawn-host",
    name: "Withdrawn Host",
    endpointCount: 0,
    quantizations: [],
    available: false,
    advertised: false,
    selected: true,
    allowFallbacks: false,
  });
});

test("discovery is restricted to registered OpenRouter conversational base routes", async () => {
  await assert.rejects(
    discoverOpenRouterProviders("deepseek/deepseek-v4-pro", { cache: false }),
    /registered OpenRouter Chat Completions model/,
  );
  await assert.rejects(
    discoverOpenRouterProviders("openrouter/not-registered", { cache: false }),
    /registered OpenRouter Chat Completions model/,
  );
});

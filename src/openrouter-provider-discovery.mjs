import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import {
  providerCatalogIdentityFingerprint,
  CATALOG_STALE_AFTER_MS,
} from "./model-catalog-cache.mjs";
import {
  MODEL_BY_SLUG,
  RUNTIME_PROVIDERS,
  resolveProviderBaseUrl,
} from "./model-registry.mjs";
import { providerModelEndpoint } from "./openai-endpoint-policy.mjs";
import { OPENROUTER_PROVIDER_CACHE_PATH } from "./paths.mjs";
import { withProviderCatalogLock } from "./provider-catalog-lock.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { fetchUntrustedJson } from "./untrusted-model-discovery.mjs";
import {
  OPENROUTER_PROVIDER_SLUG,
  readOpenRouterProviderVariants,
} from "./openrouter-provider-variants.mjs";

export const OPENROUTER_PROVIDER_CACHE_VERSION = 1;
export const OPENROUTER_PROVIDER_CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const OPENROUTER_PROVIDER_CACHE_MAX_ENTRIES = 1_000;
export const OPENROUTER_ENDPOINT_MAX_RECORDS = 4_000;
export const OPENROUTER_ENDPOINT_MAX_RECORD_BYTES = 256 * 1024;
const OPENROUTER_ENDPOINT_TAG_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,80}$/;

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validProviderRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    OPENROUTER_PROVIDER_SLUG.test(value.slug || "") &&
    typeof value.name === "string" &&
    value.name &&
    value.name.length <= 120 &&
    Number.isInteger(value.endpointCount) &&
    value.endpointCount > 0 &&
    Array.isArray(value.quantizations) &&
    value.quantizations.length <= 64 &&
    value.quantizations.every((entry) => typeof entry === "string" && entry.length <= 80) &&
    typeof value.available === "boolean"
  );
}

function emptyCache({ invalid = false } = {}) {
  return { version: OPENROUTER_PROVIDER_CACHE_VERSION, entries: {}, invalid };
}

export function readOpenRouterProviderCache(filePath = OPENROUTER_PROVIDER_CACHE_PATH) {
  if (!existsSync(filePath)) return emptyCache();
  try {
    if (
      lstatSync(filePath).isSymbolicLink() ||
      statSync(filePath).size > OPENROUTER_PROVIDER_CACHE_MAX_BYTES
    ) return emptyCache({ invalid: true });
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== OPENROUTER_PROVIDER_CACHE_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== "object" ||
      Array.isArray(parsed.entries) ||
      Object.keys(parsed.entries).length > OPENROUTER_PROVIDER_CACHE_MAX_ENTRIES ||
      Object.keys(parsed).some((key) => !["version", "entries"].includes(key))
    ) return emptyCache({ invalid: true });
    const entries = {};
    for (const [identity, entry] of Object.entries(parsed.entries)) {
      if (
        !/^[a-f0-9]{64}$/.test(identity) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.modelSlug !== "string" ||
        !validDate(entry.fetchedAt) ||
        !Array.isArray(entry.providers) ||
        entry.providers.length > OPENROUTER_ENDPOINT_MAX_RECORDS ||
        !entry.providers.every(validProviderRecord)
      ) return emptyCache({ invalid: true });
      entries[identity] = {
        modelSlug: entry.modelSlug,
        fetchedAt: entry.fetchedAt,
        providers: entry.providers.map((provider) => ({ ...provider })),
      };
    }
    return { version: OPENROUTER_PROVIDER_CACHE_VERSION, entries, invalid: false };
  } catch {
    return emptyCache({ invalid: true });
  }
}

function writeOpenRouterProviderCache(cache, filePath = OPENROUTER_PROVIDER_CACHE_PATH) {
  const sorted = Object.entries(cache.entries)
    .sort((left, right) => Date.parse(right[1].fetchedAt) - Date.parse(left[1].fetchedAt))
    .slice(0, OPENROUTER_PROVIDER_CACHE_MAX_ENTRIES);
  writePrivateJson(filePath, {
    version: OPENROUTER_PROVIDER_CACHE_VERSION,
    entries: Object.fromEntries(sorted),
  }, { directoryMode: 0o700 });
}

function serializedRecordBytes(record) {
  try {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function validateOpenRouterEndpointPayload(payload, {
  maxEndpoints = OPENROUTER_ENDPOINT_MAX_RECORDS,
  maxRecordBytes = OPENROUTER_ENDPOINT_MAX_RECORD_BYTES,
} = {}) {
  const data = payload?.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Array.isArray(data.endpoints) ||
    data.endpoints.length > maxEndpoints
  ) {
    throw new Error("OpenRouter returned an invalid or oversized endpoint inventory.");
  }
  data.endpoints.forEach((endpoint, index) => {
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      Array.isArray(endpoint) ||
      serializedRecordBytes(endpoint) > maxRecordBytes
    ) {
      throw new Error(`OpenRouter endpoint record ${index} is invalid or oversized.`);
    }
    const tag = String(endpoint.tag || "").trim().toLowerCase();
    const baseSlug = tag.split("/", 1)[0];
    const tagParts = tag.split("/");
    if (
      typeof endpoint.tag !== "string" ||
      endpoint.tag !== endpoint.tag.trim() ||
      tagParts.length > 4 ||
      tagParts.some((part) => !OPENROUTER_ENDPOINT_TAG_SEGMENT.test(part)) ||
      !OPENROUTER_PROVIDER_SLUG.test(baseSlug) ||
      typeof endpoint.provider_name !== "string" ||
      !endpoint.provider_name.trim() ||
      endpoint.provider_name !== endpoint.provider_name.trim() ||
      endpoint.provider_name.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(endpoint.provider_name) ||
      !Number.isInteger(endpoint.status)
    ) {
      throw new Error(`OpenRouter endpoint record ${index} has invalid provider identity.`);
    }
    if (
      endpoint.quantization !== undefined &&
      endpoint.quantization !== null &&
      (
        typeof endpoint.quantization !== "string" ||
        !endpoint.quantization.trim() ||
        endpoint.quantization.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(endpoint.quantization)
      )
    ) {
      throw new Error(`OpenRouter endpoint record ${index} has invalid quantization metadata.`);
    }
  });
  return data.endpoints;
}

export function groupOpenRouterProviders(payload) {
  const endpoints = validateOpenRouterEndpointPayload(payload);
  const grouped = new Map();
  for (const endpoint of endpoints) {
    const tag = endpoint.tag.trim().toLowerCase();
    const slug = tag.split("/", 1)[0];
    const current = grouped.get(slug) || {
      slug,
      name: endpoint.provider_name.trim(),
      tags: new Set(),
      quantizations: new Set(),
      available: false,
    };
    current.tags.add(tag);
    if (endpoint.quantization) current.quantizations.add(endpoint.quantization.trim());
    current.available = current.available || endpoint.status === 0;
    // Prefer the base tag's brand name if variants happen to disagree.
    if (tag === slug) current.name = endpoint.provider_name.trim();
    grouped.set(slug, current);
  }
  return [...grouped.values()]
    .map((provider) => ({
      slug: provider.slug,
      name: provider.name,
      endpointCount: provider.tags.size,
      quantizations: [...provider.quantizations].sort(),
      available: provider.available,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug));
}

function registeredOpenRouterBase(modelSlug) {
  const model = MODEL_BY_SLUG.get(String(modelSlug || ""));
  const provider = model ? RUNTIME_PROVIDERS.get(model.provider) : undefined;
  if (
    !model ||
    model.provider !== "openrouter" ||
    model.openrouterRouting ||
    providerModelEndpoint(provider) !== "/chat/completions"
  ) {
    throw new Error("OpenRouter provider discovery requires a registered OpenRouter Chat Completions model.");
  }
  return { model, provider };
}

function openRouterEndpointUrl(baseUrl, upstreamModel) {
  const parts = String(upstreamModel || "").split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !part || part.length > 200 || /[\u0000-\u001f\u007f]/.test(part))
  ) {
    throw new Error("OpenRouter model has an invalid upstream model identifier.");
  }
  return `${String(baseUrl).replace(/\/+$/, "")}/models/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/endpoints`;
}

function selectedForBase(baseModel) {
  return readOpenRouterProviderVariants().variants
    .find((entry) => entry.baseModel === baseModel);
}

function discoveryResult({ model, providers, fetchedAt, cached, stale }) {
  const selected = selectedForBase(model.slug);
  const selectedBySlug = new Map(
    (selected?.providerOrder || []).map((entry, index) => [entry.providerSlug, {
      ...entry,
      priority: index + 1,
    }]),
  );
  const result = providers.map((provider) => ({
    ...provider,
    advertised: true,
    selected: selectedBySlug.has(provider.slug),
    priority: selectedBySlug.get(provider.slug)?.priority,
  }));
  const advertised = new Set(result.map((provider) => provider.slug));
  for (const selection of selected?.providerOrder || []) {
    if (advertised.has(selection.providerSlug)) continue;
    result.push({
      slug: selection.providerSlug,
      name: selection.providerName,
      endpointCount: 0,
      quantizations: [],
      available: false,
      advertised: false,
      selected: true,
      priority: selectedBySlug.get(selection.providerSlug).priority,
    });
  }
  result.sort((left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug));
  return {
    modelSlug: model.slug,
    upstreamModel: model.upstreamModel,
    selection: {
      providerOrder: (selected?.providerOrder || []).map((provider) => provider.providerSlug),
      allowFallbacks: selected?.allowFallbacks ?? true,
    },
    providers: result,
    cached,
    stale,
    fetchedAt,
  };
}

function discoveryIdentity(model, baseUrl, credential) {
  return providerCatalogIdentityFingerprint([
    "openrouter-provider-endpoints-v1",
    model.slug,
    model.upstreamModel,
    baseUrl,
    credential,
  ]);
}

export async function discoverOpenRouterProviders(modelSlug, {
  refresh = false,
  cache = true,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  resolveHost,
  proxyResolvesDestination,
  cachePath = OPENROUTER_PROVIDER_CACHE_PATH,
} = {}) {
  const { model, provider } = registeredOpenRouterBase(modelSlug);
  const credential = resolveProviderCredential(provider);
  if (!credential?.value) throw new Error("OpenRouter is not connected. Add an API key before discovering providers.");
  const baseUrl = resolveProviderBaseUrl(provider).baseUrl;
  const identity = discoveryIdentity(model, baseUrl, credential.value);
  if (cache && !refresh) {
    const entry = readOpenRouterProviderCache(cachePath).entries[identity];
    if (entry) {
      const stale = now - Date.parse(entry.fetchedAt) >= CATALOG_STALE_AFTER_MS;
      return discoveryResult({ model, providers: entry.providers, fetchedAt: entry.fetchedAt, cached: true, stale });
    }
  }

  const payload = await fetchUntrustedJson(openRouterEndpointUrl(baseUrl, model.upstreamModel), {
    headers: { Authorization: `Bearer ${credential.value}` },
    fetchImpl,
    maxModels: OPENROUTER_ENDPOINT_MAX_RECORDS,
    maxRecordBytes: OPENROUTER_ENDPOINT_MAX_RECORD_BYTES,
    payloadValidator: (value) => validateOpenRouterEndpointPayload(value),
    ...(resolveHost ? { resolveHost } : {}),
    ...(proxyResolvesDestination !== undefined ? { proxyResolvesDestination } : {}),
  });
  const providers = groupOpenRouterProviders(payload);
  const fetchedAt = new Date(now).toISOString();

  if (cache) {
    await withProviderCatalogLock(async () => {
      const currentCredential = resolveProviderCredential(provider);
      const currentBaseUrl = resolveProviderBaseUrl(provider).baseUrl;
      if (
        !currentCredential?.value ||
        discoveryIdentity(model, currentBaseUrl, currentCredential.value) !== identity
      ) {
        throw new Error("OpenRouter credential or base URL changed during provider discovery; retry the refresh.");
      }
      const current = readOpenRouterProviderCache(cachePath);
      writeOpenRouterProviderCache({
        entries: {
          ...(current.invalid ? {} : current.entries),
          [identity]: { modelSlug: model.slug, fetchedAt, providers },
        },
      }, cachePath);
    });
  }
  return discoveryResult({ model, providers, fetchedAt, cached: false, stale: false });
}

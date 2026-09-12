import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { OPENROUTER_PROVIDER_VARIANTS_PATH } from "./paths.mjs";

export const OPENROUTER_PROVIDER_VARIANTS_VERSION = 1;
export const OPENROUTER_PROVIDER_VARIANTS_MAX_BYTES = 1024 * 1024;
export const OPENROUTER_PROVIDER_VARIANTS_MAX_ENTRIES = 1_000;
export const OPENROUTER_PROVIDER_SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const ROUTED_MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
const CONTROL_MODEL_SLUG_MAX = 201;
const PROVIDER_NAME_MAX = 120;

function textProblem(value, { max, pattern, label }) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    return `${label} is invalid`;
  }
  return undefined;
}

export function openRouterProviderVariantProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "every OpenRouter provider variant must be an object";
  }
  const allowed = new Set(["baseModel", "providerSlug", "providerName", "allowFallbacks"]);
  if (Object.keys(entry).some((key) => !allowed.has(key))) {
    return "OpenRouter provider variant contains an unsupported field";
  }
  const baseProblem = textProblem(entry.baseModel, {
    max: CONTROL_MODEL_SLUG_MAX,
    pattern: ROUTED_MODEL_SLUG,
    label: "OpenRouter base model",
  });
  if (baseProblem || !entry.baseModel.startsWith("openrouter/")) {
    return "OpenRouter base model is invalid";
  }
  const slugProblem = textProblem(entry.providerSlug, {
    max: 81,
    pattern: OPENROUTER_PROVIDER_SLUG,
    label: "OpenRouter provider slug",
  });
  if (slugProblem) return slugProblem;
  const nameProblem = textProblem(entry.providerName, {
    max: PROVIDER_NAME_MAX,
    label: "OpenRouter provider name",
  });
  if (nameProblem) return nameProblem;
  if (entry.allowFallbacks !== true) {
    return "OpenRouter provider variants must allow fallbacks in version 1";
  }
  return undefined;
}

function emptyState({ invalid = false, warning } = {}) {
  return {
    version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
    variants: [],
    invalid,
    warnings: warning ? [warning] : [],
  };
}

export function readOpenRouterProviderVariants(
  filePath = OPENROUTER_PROVIDER_VARIANTS_PATH,
) {
  if (!existsSync(filePath)) return emptyState();
  try {
    if (
      lstatSync(filePath).isSymbolicLink() ||
      statSync(filePath).size > OPENROUTER_PROVIDER_VARIANTS_MAX_BYTES
    ) {
      return emptyState({
        invalid: true,
        warning: "Ignored OpenRouter provider variants: state file is unsafe or oversized.",
      });
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== OPENROUTER_PROVIDER_VARIANTS_VERSION ||
      !Array.isArray(parsed.variants) ||
      parsed.variants.length > OPENROUTER_PROVIDER_VARIANTS_MAX_ENTRIES ||
      Object.keys(parsed).some((key) => !["version", "variants"].includes(key))
    ) {
      return emptyState({
        invalid: true,
        warning: "Ignored OpenRouter provider variants: state file has an invalid schema.",
      });
    }
    const variants = [];
    const identities = new Set();
    for (const entry of parsed.variants) {
      const problem = openRouterProviderVariantProblem(entry);
      const identity = `${entry?.baseModel || ""}\0${entry?.providerSlug || ""}`;
      if (problem || identities.has(identity)) {
        return emptyState({
          invalid: true,
          warning: `Ignored OpenRouter provider variants: ${problem || "duplicate selection"}.`,
        });
      }
      identities.add(identity);
      variants.push(Object.freeze({ ...entry }));
    }
    return {
      version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
      variants: Object.freeze(variants),
      invalid: false,
      warnings: Object.freeze([]),
    };
  } catch (error) {
    return emptyState({
      invalid: true,
      warning: `Ignored OpenRouter provider variants: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function writeOpenRouterProviderVariants(
  variants,
  filePath = OPENROUTER_PROVIDER_VARIANTS_PATH,
) {
  if (!Array.isArray(variants) || variants.length > OPENROUTER_PROVIDER_VARIANTS_MAX_ENTRIES) {
    throw new Error("OpenRouter provider variant selection is oversized.");
  }
  const identities = new Set();
  const normalized = variants.map((entry) => {
    const value = {
      baseModel: String(entry?.baseModel || "").trim(),
      providerSlug: String(entry?.providerSlug || "").trim().toLowerCase(),
      providerName: String(entry?.providerName || "").trim(),
      allowFallbacks: true,
    };
    const problem = openRouterProviderVariantProblem(value);
    if (problem) throw new Error(problem);
    const identity = `${value.baseModel}\0${value.providerSlug}`;
    if (identities.has(identity)) throw new Error("Duplicate OpenRouter provider variant selection.");
    identities.add(identity);
    return value;
  });
  normalized.sort((left, right) => (
    left.baseModel.localeCompare(right.baseModel) ||
    left.providerSlug.localeCompare(right.providerSlug)
  ));
  writePrivateJson(filePath, {
    version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
    variants: normalized,
  }, { directoryMode: 0o700 });
  return normalized;
}

export function replaceOpenRouterProviderVariants(
  baseModel,
  selections,
  filePath = OPENROUTER_PROVIDER_VARIANTS_PATH,
) {
  const current = readOpenRouterProviderVariants(filePath);
  if (current.invalid) {
    throw new Error("OpenRouter provider variant state is invalid; refusing to overwrite it.");
  }
  const retained = current.variants.filter((entry) => entry.baseModel !== baseModel);
  return writeOpenRouterProviderVariants([
    ...retained,
    ...(selections || []).map((entry) => ({
      baseModel,
      providerSlug: entry.providerSlug,
      providerName: entry.providerName,
      allowFallbacks: true,
    })),
  ], filePath);
}

function derivedSuffix(providerSlug) {
  return `via-${providerSlug}`;
}

export function openRouterVariantIdentity(baseModel, providerSlug) {
  const slug = `${baseModel.slug}-${derivedSuffix(providerSlug)}`;
  const gatewayModel = `${baseModel.gatewayModel}-${derivedSuffix(providerSlug)}`;
  if (!ROUTED_MODEL_SLUG.test(slug) || slug.length > CONTROL_MODEL_SLUG_MAX) {
    throw new Error(`Derived OpenRouter model slug is invalid or oversized: ${slug}`);
  }
  if (
    gatewayModel.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(gatewayModel)
  ) {
    throw new Error(`Derived OpenRouter gateway model is invalid or oversized: ${gatewayModel}`);
  }
  return { slug, gatewayModel };
}

export function materializeOpenRouterProviderVariant(baseModel, selection) {
  const problem = openRouterProviderVariantProblem(selection);
  if (problem) throw new Error(problem);
  if (!baseModel || baseModel.slug !== selection.baseModel || baseModel.provider !== "openrouter") {
    throw new Error(`OpenRouter provider variant base model is unavailable: ${selection.baseModel}`);
  }
  const { slug, gatewayModel } = openRouterVariantIdentity(baseModel, selection.providerSlug);
  const baseDisplay = String(baseModel.displayName || baseModel.slug)
    .replace(/\s*\(OpenRouter\)\s*$/i, "")
    .trim();
  const compHash = createHash("sha256")
    .update(JSON.stringify({
      baseCompHash: baseModel.compHash,
      baseModel: baseModel.slug,
      providerSlug: selection.providerSlug,
      allowFallbacks: true,
    }))
    .digest("hex")
    .slice(0, 32);
  const inherited = { ...baseModel };
  delete inherited.multiAgentVersion;
  delete inherited.subagentSelectedByOperator;
  delete inherited.subagentVerifiedLocally;
  delete inherited.upgradeTo;
  return Object.freeze({
    ...inherited,
    slug,
    gatewayModel,
    displayName: `${baseDisplay} (OpenRouter · ${selection.providerName} preferred)`,
    description: `${baseModel.description || baseDisplay} Preferred OpenRouter route through ${selection.providerName}, with fallback enabled.`,
    compHash: `openrouter-provider-${compHash}`,
    multiAgentVersion: "v1",
    openrouterRouting: Object.freeze({
      baseModel: selection.baseModel,
      providerSlug: selection.providerSlug,
      providerName: selection.providerName,
      allowFallbacks: true,
    }),
  });
}

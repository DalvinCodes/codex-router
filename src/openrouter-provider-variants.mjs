import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { OPENROUTER_PROVIDER_VARIANTS_PATH } from "./paths.mjs";

const LEGACY_OPENROUTER_PROVIDER_VARIANTS_VERSION = 1;
export const OPENROUTER_PROVIDER_VARIANTS_VERSION = 2;
export const OPENROUTER_PROVIDER_VARIANTS_MAX_BYTES = 1024 * 1024;
export const OPENROUTER_PROVIDER_VARIANTS_MAX_ENTRIES = 1_000;
export const OPENROUTER_PROVIDER_ORDER_MAX_ENTRIES = 200;
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

function providerProblem(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return "every OpenRouter provider priority entry must be an object";
  }
  if (Object.keys(provider).some((key) => !["providerSlug", "providerName"].includes(key))) {
    return "OpenRouter provider priority entry contains an unsupported field";
  }
  const slugProblem = textProblem(provider.providerSlug, {
    max: 81,
    pattern: OPENROUTER_PROVIDER_SLUG,
    label: "OpenRouter provider slug",
  });
  if (slugProblem) return slugProblem;
  return textProblem(provider.providerName, {
    max: PROVIDER_NAME_MAX,
    label: "OpenRouter provider name",
  });
}

export function openRouterProviderVariantProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "every OpenRouter provider variant must be an object";
  }
  const allowed = new Set(["baseModel", "providerOrder", "allowFallbacks"]);
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
  if (
    !Array.isArray(entry.providerOrder) ||
    !entry.providerOrder.length ||
    entry.providerOrder.length > OPENROUTER_PROVIDER_ORDER_MAX_ENTRIES
  ) {
    return "OpenRouter provider priority order is invalid or oversized";
  }
  const slugs = new Set();
  for (const provider of entry.providerOrder) {
    const problem = providerProblem(provider);
    if (problem) return problem;
    if (slugs.has(provider.providerSlug)) {
      return "OpenRouter provider priority order contains a duplicate provider";
    }
    slugs.add(provider.providerSlug);
  }
  if (typeof entry.allowFallbacks !== "boolean") {
    return "OpenRouter provider variant fallback policy is invalid";
  }
  return undefined;
}

function legacyVariantProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "every legacy OpenRouter provider variant must be an object";
  }
  if (Object.keys(entry).some((key) => ![
    "baseModel",
    "providerSlug",
    "providerName",
    "allowFallbacks",
  ].includes(key))) {
    return "legacy OpenRouter provider variant contains an unsupported field";
  }
  const problem = openRouterProviderVariantProblem({
    baseModel: entry.baseModel,
    providerOrder: [{
      providerSlug: entry.providerSlug,
      providerName: entry.providerName,
    }],
    allowFallbacks: entry.allowFallbacks,
  });
  return problem?.replace("OpenRouter provider variant", "legacy OpenRouter provider variant");
}

function frozenVariant(entry) {
  return Object.freeze({
    baseModel: entry.baseModel,
    providerOrder: Object.freeze(entry.providerOrder.map((provider) => Object.freeze({ ...provider }))),
    allowFallbacks: entry.allowFallbacks,
  });
}

function emptyState({ invalid = false, warning } = {}) {
  return {
    version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
    sourceVersion: OPENROUTER_PROVIDER_VARIANTS_VERSION,
    variants: Object.freeze([]),
    legacyVariants: Object.freeze([]),
    invalid,
    warnings: Object.freeze(warning ? [warning] : []),
  };
}

function readLegacyVariants(entries) {
  const identities = new Set();
  const byBase = new Map();
  for (const entry of entries) {
    const problem = legacyVariantProblem(entry);
    const identity = `${entry?.baseModel || ""}\0${entry?.providerSlug || ""}`;
    if (problem || identities.has(identity)) {
      throw new Error(problem || "duplicate legacy selection");
    }
    identities.add(identity);
    const group = byBase.get(entry.baseModel) || [];
    group.push(entry);
    byBase.set(entry.baseModel, group);
  }
  const warnings = [];
  const variants = [];
  for (const [baseModel, group] of byBase) {
    if (group.length > 1) {
      warnings.push(
        `Legacy OpenRouter variants for ${baseModel} were combined in their stored order; review the provider priority before saving.`,
      );
    }
    variants.push(frozenVariant({
      baseModel,
      providerOrder: group.map((entry) => ({
        providerSlug: entry.providerSlug,
        providerName: entry.providerName,
      })),
      // Do not broaden a formerly strict route while combining independent
      // legacy variants. The operator can explicitly enable automatic
      // fallbacks after reviewing the new ordered chain.
      allowFallbacks: group.every((entry) => entry.allowFallbacks),
    }));
  }
  variants.sort((left, right) => left.baseModel.localeCompare(right.baseModel));
  return { variants, warnings };
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
      ![LEGACY_OPENROUTER_PROVIDER_VARIANTS_VERSION, OPENROUTER_PROVIDER_VARIANTS_VERSION]
        .includes(parsed.version) ||
      !Array.isArray(parsed.variants) ||
      parsed.variants.length > OPENROUTER_PROVIDER_VARIANTS_MAX_ENTRIES ||
      Object.keys(parsed).some((key) => !["version", "variants"].includes(key))
    ) {
      return emptyState({
        invalid: true,
        warning: "Ignored OpenRouter provider variants: state file has an invalid schema.",
      });
    }
    if (parsed.version === LEGACY_OPENROUTER_PROVIDER_VARIANTS_VERSION) {
      const legacy = parsed.variants.map((entry) => Object.freeze({ ...entry }));
      const migrated = readLegacyVariants(legacy);
      return {
        version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
        sourceVersion: LEGACY_OPENROUTER_PROVIDER_VARIANTS_VERSION,
        variants: Object.freeze(migrated.variants),
        legacyVariants: Object.freeze(legacy),
        invalid: false,
        warnings: Object.freeze(migrated.warnings),
      };
    }
    const variants = [];
    const baseModels = new Set();
    for (const entry of parsed.variants) {
      const problem = openRouterProviderVariantProblem(entry);
      if (problem || baseModels.has(entry?.baseModel)) {
        return emptyState({
          invalid: true,
          warning: `Ignored OpenRouter provider variants: ${problem || "duplicate base model selection"}.`,
        });
      }
      baseModels.add(entry.baseModel);
      variants.push(frozenVariant(entry));
    }
    return {
      version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
      sourceVersion: OPENROUTER_PROVIDER_VARIANTS_VERSION,
      variants: Object.freeze(variants),
      legacyVariants: Object.freeze([]),
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
  const baseModels = new Set();
  const normalized = variants.map((entry) => {
    const value = {
      baseModel: String(entry?.baseModel || "").trim(),
      providerOrder: Array.isArray(entry?.providerOrder)
        ? entry.providerOrder.map((provider) => ({
            providerSlug: String(provider?.providerSlug || "").trim().toLowerCase(),
            providerName: String(provider?.providerName || "").trim(),
          }))
        : [],
      allowFallbacks: entry?.allowFallbacks === undefined ? true : entry.allowFallbacks,
    };
    const problem = openRouterProviderVariantProblem(value);
    if (problem) throw new Error(problem);
    if (baseModels.has(value.baseModel)) {
      throw new Error("Duplicate OpenRouter provider chain for one base model.");
    }
    baseModels.add(value.baseModel);
    return value;
  });
  normalized.sort((left, right) => left.baseModel.localeCompare(right.baseModel));
  writePrivateJson(filePath, {
    version: OPENROUTER_PROVIDER_VARIANTS_VERSION,
    variants: normalized,
  }, { directoryMode: 0o700 });
  return normalized;
}

export function replaceOpenRouterProviderVariants(
  baseModel,
  selection,
  filePath = OPENROUTER_PROVIDER_VARIANTS_PATH,
) {
  const current = readOpenRouterProviderVariants(filePath);
  if (current.invalid) {
    throw new Error("OpenRouter provider variant state is invalid; refusing to overwrite it.");
  }
  const retained = current.variants.filter((entry) => entry.baseModel !== baseModel);
  const replacement = selection?.providerOrder?.length
    ? [{
        baseModel,
        providerOrder: selection.providerOrder,
        allowFallbacks: selection.allowFallbacks,
      }]
    : [];
  return writeOpenRouterProviderVariants([...retained, ...replacement], filePath);
}

function primaryProviderSlug(providerOrder) {
  const slug = providerOrder?.[0]?.providerSlug;
  if (!OPENROUTER_PROVIDER_SLUG.test(String(slug || ""))) {
    throw new Error("An OpenRouter provider chain requires a valid first provider.");
  }
  return slug;
}

function derivedSuffix(providerOrder) {
  return `via-${primaryProviderSlug(providerOrder)}`;
}

export function openRouterVariantIdentity(baseModel, providerOrder) {
  const slug = `${baseModel.slug}-${derivedSuffix(providerOrder)}`;
  const gatewayModel = `${baseModel.gatewayModel}-${derivedSuffix(providerOrder)}`;
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

function providerOrderLabel(providerOrder, maxVisible = 3) {
  const visible = providerOrder.slice(0, maxVisible).map((provider) => provider.providerName);
  const hidden = providerOrder.length - visible.length;
  return `${visible.join(" → ")}${hidden > 0 ? ` → +${hidden} more` : ""}`;
}

export function materializeOpenRouterProviderVariant(baseModel, selection) {
  const problem = openRouterProviderVariantProblem(selection);
  if (problem) throw new Error(problem);
  if (!baseModel || baseModel.slug !== selection.baseModel || baseModel.provider !== "openrouter") {
    throw new Error(`OpenRouter provider variant base model is unavailable: ${selection.baseModel}`);
  }
  const { slug, gatewayModel } = openRouterVariantIdentity(baseModel, selection.providerOrder);
  const baseDisplay = String(baseModel.displayName || baseModel.slug)
    .replace(/\s*\(OpenRouter\)\s*$/i, "")
    .trim();
  const providerLabel = providerOrderLabel(selection.providerOrder);
  const fullProviderLabel = selection.providerOrder.map((provider) => provider.providerName).join(" → ");
  const compHash = createHash("sha256")
    .update(JSON.stringify({
      baseCompHash: baseModel.compHash,
      baseModel: baseModel.slug,
      providerOrder: selection.providerOrder.map((provider) => provider.providerSlug),
      allowFallbacks: selection.allowFallbacks,
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
    displayName: `${baseDisplay} (OpenRouter · ${providerLabel}${selection.allowFallbacks ? " → Automatic" : " only"})`,
    description: selection.allowFallbacks
      ? `${baseModel.description || baseDisplay} OpenRouter tries ${fullProviderLabel} in that order, then may use another provider.`
      : `${baseModel.description || baseDisplay} OpenRouter is restricted to ${fullProviderLabel}, in that order.`,
    compHash: `openrouter-provider-${compHash}`,
    multiAgentVersion: "v1",
    openrouterRouting: Object.freeze({
      baseModel: selection.baseModel,
      providerOrder: Object.freeze(selection.providerOrder.map((provider) => Object.freeze({ ...provider }))),
      allowFallbacks: selection.allowFallbacks,
    }),
  });
}

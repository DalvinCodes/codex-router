import { MODEL_BY_SLUG, MODELS, RUNTIME_PROVIDERS } from "./model-registry.mjs";
import { forgetModelVisibility, MODEL_PICKER_STATE_PATH, setModelsVisible } from "./model-picker-state.mjs";
import { transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { forgetMultiAgentModels, MULTI_AGENT_STATE_PATH } from "./multi-agent-state.mjs";
import { providerModelEndpoint } from "./openai-endpoint-policy.mjs";
import { discoverOpenRouterProviders } from "./openrouter-provider-discovery.mjs";
import {
  OPENROUTER_PROVIDER_ORDER_MAX_ENTRIES,
  OPENROUTER_PROVIDER_SLUG,
  openRouterVariantIdentity,
  readOpenRouterProviderVariants,
  replaceOpenRouterProviderVariants,
} from "./openrouter-provider-variants.mjs";
import { OPENROUTER_PROVIDER_VARIANTS_PATH } from "./paths.mjs";
import { clearSubagentProof, SUBAGENT_PROOFS_PATH } from "./subagent-proofs.mjs";

function normalizedProviderSelection(providerSelection) {
  if (!providerSelection || typeof providerSelection !== "object" || Array.isArray(providerSelection)) {
    throw new Error("OpenRouter provider selection must be an ordered chain.");
  }
  if (Object.keys(providerSelection).some((key) => !["providerOrder", "allowFallbacks"].includes(key))) {
    throw new Error("OpenRouter provider selection contains an unsupported field.");
  }
  if (
    !Array.isArray(providerSelection.providerOrder) ||
    providerSelection.providerOrder.length > OPENROUTER_PROVIDER_ORDER_MAX_ENTRIES
  ) {
    throw new Error(`Choose no more than ${OPENROUTER_PROVIDER_ORDER_MAX_ENTRIES} OpenRouter providers.`);
  }
  if (typeof providerSelection.allowFallbacks !== "boolean") {
    throw new Error("OpenRouter provider chain fallback policy is invalid.");
  }
  const providerOrder = [];
  const seen = new Set();
  for (const value of providerSelection.providerOrder) {
    const providerSlug = String(value || "").trim().toLowerCase();
    if (!OPENROUTER_PROVIDER_SLUG.test(providerSlug)) {
      throw new Error("One or more OpenRouter provider slugs are invalid.");
    }
    if (seen.has(providerSlug)) {
      throw new Error(`OpenRouter provider ${providerSlug} appears more than once in the priority order.`);
    }
    seen.add(providerSlug);
    providerOrder.push(providerSlug);
  }
  return {
    providerOrder,
    allowFallbacks: providerSelection.allowFallbacks,
  };
}

function selectedStateFor(state, baseModel) {
  const entry = state.variants.find((candidate) => candidate.baseModel === baseModel);
  if (!entry) return undefined;
  return {
    baseModel: entry.baseModel,
    providerOrder: entry.providerOrder.map((provider) => ({ ...provider })),
    allowFallbacks: entry.allowFallbacks,
  };
}

function publicRouteSlug(baseModel, providerSlug) {
  return `${baseModel}-via-${providerSlug}`;
}

// Public mutation boundary shared by the CLI and Control Center. Discovery is
// deliberately completed before the overlay lock, while an optimistic state
// check inside the transaction prevents a concurrent same-model selection from
// being overwritten by choices based on an older provider list.
export async function setOpenRouterProviders(modelSlug, providerSelection, {
  discover = discoverOpenRouterProviders,
  models = MODELS,
  modelBySlug = MODEL_BY_SLUG,
  variantsPath = OPENROUTER_PROVIDER_VARIANTS_PATH,
  transact = transactModelOverlayMutation,
} = {}) {
  const normalizedModel = String(modelSlug || "").trim();
  if (!normalizedModel) throw new Error("An OpenRouter model slug is required.");
  const requested = normalizedProviderSelection(providerSelection);

  const currentState = readOpenRouterProviderVariants(variantsPath);
  if (currentState.invalid) {
    throw new Error("OpenRouter provider variant state is invalid; refusing to overwrite it.");
  }
  const expectedState = selectedStateFor(currentState, normalizedModel);
  const existing = new Map(
    (expectedState?.providerOrder || []).map((entry) => [entry.providerSlug, entry]),
  );
  const baseModel = modelBySlug.get(normalizedModel);
  const validBase = Boolean(
    baseModel &&
    baseModel.provider === "openrouter" &&
    !baseModel.openrouterRouting &&
    providerModelEndpoint(RUNTIME_PROVIDERS.get(baseModel.provider)) === "/chat/completions"
  );
  if (!validBase && (requested.providerOrder.length || !existing.size)) {
    throw new Error(
      "OpenRouter provider selection requires a registered OpenRouter Chat Completions base model.",
    );
  }

  // Existing selections that have been withdrawn may be retained or removed,
  // but every newly named brand must appear in a fresh endpoint inventory.
  // Clearing is offline-capable so inactive state remains removable after its
  // base model disappears.
  const discovery = requested.providerOrder.length
    ? await discover(normalizedModel, { refresh: true })
    : undefined;
  const advertised = new Map(
    (discovery?.providers || [])
      .filter((provider) => provider.advertised)
      .map((provider) => [provider.slug, provider]),
  );
  const providerOrder = requested.providerOrder.map((providerSlug) => {
    const live = advertised.get(providerSlug);
    const retained = existing.get(providerSlug);
    if (!live && !retained) {
      throw new Error(`OpenRouter did not advertise provider ${providerSlug} for ${normalizedModel}.`);
    }
    return {
      providerSlug,
      providerName: live?.name || retained.providerName,
    };
  });
  const selection = providerOrder.length
    ? {
        baseModel: normalizedModel,
        providerOrder,
        allowFallbacks: requested.allowFallbacks,
      }
    : undefined;

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  const byGateway = new Map(models.map((model) => [model.gatewayModel, model]));
  let nextRoute;
  if (selection) {
    nextRoute = openRouterVariantIdentity(baseModel, selection.providerOrder);
    const expectedOwner = (model) => (
      model?.openrouterRouting?.baseModel === normalizedModel &&
      model?.openrouterRouting?.providerOrder?.[0]?.providerSlug === providerOrder[0].providerSlug
    );
    if (bySlug.has(nextRoute.slug) && !expectedOwner(bySlug.get(nextRoute.slug))) {
      throw new Error(`Derived OpenRouter model slug collides with an existing route: ${nextRoute.slug}`);
    }
    if (byGateway.has(nextRoute.gatewayModel) && !expectedOwner(byGateway.get(nextRoute.gatewayModel))) {
      throw new Error(`Derived OpenRouter gateway model collides with an existing route: ${nextRoute.gatewayModel}`);
    }
  }

  const oldRoutes = currentState.sourceVersion === 1
    ? currentState.legacyVariants
      .filter((entry) => entry.baseModel === normalizedModel)
      .map((entry) => publicRouteSlug(normalizedModel, entry.providerSlug))
    : expectedState
      ? [publicRouteSlug(normalizedModel, expectedState.providerOrder[0].providerSlug)]
      : [];
  const oldRouteSet = new Set(oldRoutes);
  const nextSlug = nextRoute?.slug;
  const removedRoutes = oldRoutes.filter((slug) => slug !== nextSlug);
  const addedRoutes = nextSlug && !oldRouteSet.has(nextSlug) ? [nextSlug] : [];
  const selectionChanged = JSON.stringify(expectedState) !== JSON.stringify(selection);

  const publication = await transact({
    files: [
      variantsPath,
      MODEL_PICKER_STATE_PATH,
      MULTI_AGENT_STATE_PATH,
      SUBAGENT_PROOFS_PATH,
    ],
    mutate: async () => {
      const lockedState = readOpenRouterProviderVariants(variantsPath);
      if (lockedState.invalid) {
        throw new Error("OpenRouter provider variant state became invalid; refusing to overwrite it.");
      }
      if (
        lockedState.sourceVersion !== currentState.sourceVersion ||
        JSON.stringify(selectedStateFor(lockedState, normalizedModel)) !== JSON.stringify(expectedState)
      ) {
        throw new Error(
          `OpenRouter provider selections for ${normalizedModel} changed while this update was pending; retry with the current inventory.`,
        );
      }
      replaceOpenRouterProviderVariants(normalizedModel, selection, variantsPath);
      if (removedRoutes.length) forgetModelVisibility(removedRoutes);
      if (nextSlug) setModelsVisible([nextSlug], true);
      const resetRoutes = [...new Set([
        ...removedRoutes,
        ...addedRoutes,
        ...(selectionChanged && nextSlug ? [nextSlug] : []),
      ])];
      if (resetRoutes.length) {
        forgetMultiAgentModels(resetRoutes);
        for (const slug of resetRoutes) clearSubagentProof(slug);
      }
    },
    restart: true,
  });

  return {
    modelSlug: normalizedModel,
    selection: selection
      ? {
          providerOrder: selection.providerOrder.map((provider) => provider.providerSlug),
          allowFallbacks: selection.allowFallbacks,
        }
      : { providerOrder: [], allowFallbacks: requested.allowFallbacks },
    addedRoutes,
    removedRoutes,
    publication,
  };
}

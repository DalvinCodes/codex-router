import { MODEL_BY_SLUG, MODELS, RUNTIME_PROVIDERS } from "./model-registry.mjs";
import { forgetModelVisibility, MODEL_PICKER_STATE_PATH, setModelsVisible } from "./model-picker-state.mjs";
import { transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { forgetMultiAgentModels, MULTI_AGENT_STATE_PATH } from "./multi-agent-state.mjs";
import { providerModelEndpoint } from "./openai-endpoint-policy.mjs";
import { discoverOpenRouterProviders } from "./openrouter-provider-discovery.mjs";
import {
  OPENROUTER_PROVIDER_SLUG,
  openRouterVariantIdentity,
  readOpenRouterProviderVariants,
  replaceOpenRouterProviderVariants,
} from "./openrouter-provider-variants.mjs";
import { OPENROUTER_PROVIDER_VARIANTS_PATH } from "./paths.mjs";
import { clearSubagentProof, SUBAGENT_PROOFS_PATH } from "./subagent-proofs.mjs";

function normalizedProviderSlugs(providerSlugs) {
  if (!Array.isArray(providerSlugs)) {
    throw new Error("OpenRouter provider selections must be an array.");
  }
  const values = [...new Set(
    providerSlugs.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean),
  )];
  if (values.some((slug) => !OPENROUTER_PROVIDER_SLUG.test(slug))) {
    throw new Error("One or more OpenRouter provider slugs are invalid.");
  }
  return values;
}

function selectedStateFor(state, baseModel) {
  return state.variants
    .filter((entry) => entry.baseModel === baseModel)
    .map((entry) => ({
      baseModel: entry.baseModel,
      providerSlug: entry.providerSlug,
      providerName: entry.providerName,
      allowFallbacks: entry.allowFallbacks,
    }))
    .sort((left, right) => left.providerSlug.localeCompare(right.providerSlug));
}

// Public mutation boundary shared by the CLI and Control Center. Discovery is
// deliberately completed before the overlay lock, while an optimistic state
// check inside the transaction prevents a concurrent same-model selection from
// being overwritten by choices based on an older provider list.
export async function setOpenRouterProviders(modelSlug, providerSlugs, {
  discover = discoverOpenRouterProviders,
  models = MODELS,
  modelBySlug = MODEL_BY_SLUG,
  variantsPath = OPENROUTER_PROVIDER_VARIANTS_PATH,
  transact = transactModelOverlayMutation,
} = {}) {
  const normalizedModel = String(modelSlug || "").trim();
  if (!normalizedModel) throw new Error("An OpenRouter model slug is required.");
  const requestedSlugs = normalizedProviderSlugs(providerSlugs);

  const currentState = readOpenRouterProviderVariants(variantsPath);
  if (currentState.invalid) {
    throw new Error("OpenRouter provider variant state is invalid; refusing to overwrite it.");
  }
  const expectedState = selectedStateFor(currentState, normalizedModel);
  const existing = new Map(expectedState.map((entry) => [entry.providerSlug, entry]));
  const baseModel = modelBySlug.get(normalizedModel);
  const validBase = Boolean(
    baseModel &&
    baseModel.provider === "openrouter" &&
    !baseModel.openrouterRouting &&
    providerModelEndpoint(RUNTIME_PROVIDERS.get(baseModel.provider)) === "/chat/completions"
  );
  if (!validBase && (requestedSlugs.length || !existing.size)) {
    throw new Error(
      "OpenRouter provider selection requires a registered OpenRouter Chat Completions base model.",
    );
  }

  // Existing selections that have been withdrawn may be retained or removed,
  // but every newly named brand must appear in a fresh endpoint inventory.
  // Clearing is offline-capable so inactive state remains removable after its
  // base model disappears.
  const discovery = requestedSlugs.length
    ? await discover(normalizedModel, { refresh: true })
    : undefined;
  const advertised = new Map(
    (discovery?.providers || [])
      .filter((provider) => provider.advertised)
      .map((provider) => [provider.slug, provider]),
  );
  const selections = requestedSlugs.map((providerSlug) => {
    const live = advertised.get(providerSlug);
    const retained = existing.get(providerSlug);
    if (!live && !retained) {
      throw new Error(`OpenRouter did not advertise provider ${providerSlug} for ${normalizedModel}.`);
    }
    return {
      providerSlug,
      providerName: live?.name || retained.providerName,
      allowFallbacks: true,
    };
  });

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  const byGateway = new Map(models.map((model) => [model.gatewayModel, model]));
  for (const selection of selections) {
    const identity = openRouterVariantIdentity(baseModel, selection.providerSlug);
    const expectedOwner = (model) => (
      model?.openrouterRouting?.baseModel === normalizedModel &&
      model?.openrouterRouting?.providerSlug === selection.providerSlug
    );
    if (bySlug.has(identity.slug) && !expectedOwner(bySlug.get(identity.slug))) {
      throw new Error(`Derived OpenRouter model slug collides with an existing route: ${identity.slug}`);
    }
    if (byGateway.has(identity.gatewayModel) && !expectedOwner(byGateway.get(identity.gatewayModel))) {
      throw new Error(`Derived OpenRouter gateway model collides with an existing route: ${identity.gatewayModel}`);
    }
  }

  const oldSlugs = new Map(
    [...existing].map(([providerSlug]) => [providerSlug, `${normalizedModel}-via-${providerSlug}`]),
  );
  const nextSlugSet = new Set(requestedSlugs);
  const removedRoutes = [...oldSlugs]
    .filter(([providerSlug]) => !nextSlugSet.has(providerSlug))
    .map(([, slug]) => slug);
  const addedRoutes = selections
    .filter((selection) => !existing.has(selection.providerSlug))
    .map((selection) => openRouterVariantIdentity(baseModel, selection.providerSlug).slug);

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
        JSON.stringify(selectedStateFor(lockedState, normalizedModel)) !==
        JSON.stringify(expectedState)
      ) {
        throw new Error(
          `OpenRouter provider selections for ${normalizedModel} changed while this update was pending; retry with the current inventory.`,
        );
      }
      replaceOpenRouterProviderVariants(normalizedModel, selections, variantsPath);
      if (removedRoutes.length) forgetModelVisibility(removedRoutes);
      if (addedRoutes.length) {
        forgetMultiAgentModels(addedRoutes);
        for (const slug of addedRoutes) clearSubagentProof(slug);
        setModelsVisible(addedRoutes, true);
      }
      if (removedRoutes.length) {
        forgetMultiAgentModels(removedRoutes);
        for (const slug of removedRoutes) clearSubagentProof(slug);
      }
    },
    restart: true,
  });

  return {
    modelSlug: normalizedModel,
    selections,
    addedRoutes,
    removedRoutes,
    publication,
  };
}

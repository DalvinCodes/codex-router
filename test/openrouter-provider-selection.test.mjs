import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "openrouter-provider-selection-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const { setOpenRouterProviders } = await import("../src/openrouter-provider-selection.mjs");
const { readVisibleModels } = await import("../src/model-picker-state.mjs");
const { transactModelOverlayMutation } = await import("../src/model-overlay-publication.mjs");
const {
  readOpenRouterProviderVariants,
  writeOpenRouterProviderVariants,
} = await import("../src/openrouter-provider-variants.mjs");
const { OPENROUTER_PROVIDER_VARIANTS_PATH } = await import("../src/paths.mjs");

const baseModel = "openrouter/deepseek-v4.1-flash";

function liveProviders() {
  return {
    modelSlug: baseModel,
    selection: { providerOrder: [], allowFallbacks: true },
    providers: [
      {
        slug: "deepinfra",
        name: "DeepInfra",
        endpointCount: 2,
        quantizations: ["fp8"],
        available: true,
        advertised: true,
        selected: false,
      },
      {
        slug: "together",
        name: "Together AI",
        endpointCount: 1,
        quantizations: ["fp16"],
        available: true,
        advertised: true,
        selected: false,
      },
    ],
    cached: false,
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  writeOpenRouterProviderVariants([]);
});

test("setOpenRouterProviders validates and persists the exact provider priority", async () => {
  const discoveries = [];
  const result = await setOpenRouterProviders(baseModel, {
    providerOrder: ["together", "deepinfra"],
    allowFallbacks: true,
  }, {
    discover: async (modelSlug, options) => {
      discoveries.push({ modelSlug, options });
      return liveProviders();
    },
    transact: async ({ files, mutate, restart }) => {
      assert.equal(restart, true);
      assert.equal(files.length, 4);
      await mutate();
      return { published: true, restarted: true };
    },
  });

  assert.deepEqual(discoveries, [{ modelSlug: baseModel, options: { refresh: true } }]);
  assert.deepEqual(result.addedRoutes, [`${baseModel}-via-together`]);
  assert.deepEqual(result.removedRoutes, []);
  assert.deepEqual(readOpenRouterProviderVariants().variants, [{
    baseModel,
    providerOrder: [
      { providerSlug: "together", providerName: "Together AI" },
      { providerSlug: "deepinfra", providerName: "DeepInfra" },
    ],
    allowFallbacks: true,
  }]);
  assert.equal(readVisibleModels().has(`${baseModel}-via-together`), true);
});

test("setOpenRouterProviders persists one fallback policy for the whole chain", async () => {
  writeOpenRouterProviderVariants([{
    baseModel,
    providerOrder: [{ providerSlug: "deepinfra", providerName: "DeepInfra" }],
    allowFallbacks: true,
  }]);
  const result = await setOpenRouterProviders(baseModel, {
    providerOrder: ["deepinfra", "together"],
    allowFallbacks: false,
  }, {
    discover: async () => liveProviders(),
    transact: async ({ mutate }) => {
      await mutate();
      return { published: true, restarted: true };
    },
  });
  assert.deepEqual(result.addedRoutes, []);
  assert.deepEqual(result.removedRoutes, []);
  assert.deepEqual(readOpenRouterProviderVariants().variants[0], {
    baseModel,
    providerOrder: [
      { providerSlug: "deepinfra", providerName: "DeepInfra" },
      { providerSlug: "together", providerName: "Together AI" },
    ],
    allowFallbacks: false,
  });
});

test("setOpenRouterProviders rejects duplicate positions before discovery", async () => {
  await assert.rejects(
    setOpenRouterProviders(baseModel, {
      providerOrder: ["deepinfra", "deepinfra"],
      allowFallbacks: true,
    }, {
      discover: async () => assert.fail("invalid selections must fail before discovery"),
    }),
    /appears more than once/,
  );
});

test("setOpenRouterProviders refuses a concurrent same-model selection change", async () => {
  await assert.rejects(
    setOpenRouterProviders(baseModel, {
      providerOrder: ["deepinfra"],
      allowFallbacks: true,
    }, {
      discover: async () => liveProviders(),
      transact: async ({ mutate }) => {
        writeOpenRouterProviderVariants([{
          baseModel,
          providerOrder: [{ providerSlug: "together", providerName: "Together AI" }],
          allowFallbacks: true,
        }]);
        await mutate();
      },
    }),
    /changed while this update was pending/,
  );
});

test("reordering the primary provider replaces the picker route identity", async () => {
  writeOpenRouterProviderVariants([{
    baseModel,
    providerOrder: [
      { providerSlug: "deepinfra", providerName: "DeepInfra" },
      { providerSlug: "together", providerName: "Together AI" },
    ],
    allowFallbacks: false,
  }]);
  const result = await setOpenRouterProviders(baseModel, {
    providerOrder: ["together", "deepinfra"],
    allowFallbacks: false,
  }, {
    discover: async () => liveProviders(),
    transact: async ({ mutate }) => {
      await mutate();
      return { published: true };
    },
  });
  assert.deepEqual(result.removedRoutes, [`${baseModel}-via-deepinfra`]);
  assert.deepEqual(result.addedRoutes, [`${baseModel}-via-together`]);
});

test("legacy independent routes collapse and their extra picker state is removed", async () => {
  writeFileSync(OPENROUTER_PROVIDER_VARIANTS_PATH, JSON.stringify({
    version: 1,
    variants: [
      {
        baseModel,
        providerSlug: "deepinfra",
        providerName: "DeepInfra",
        allowFallbacks: true,
      },
      {
        baseModel,
        providerSlug: "together",
        providerName: "Together AI",
        allowFallbacks: true,
      },
    ],
  }));
  const result = await setOpenRouterProviders(baseModel, {
    providerOrder: ["deepinfra", "together"],
    allowFallbacks: true,
  }, {
    discover: async () => liveProviders(),
    transact: async ({ mutate }) => {
      await mutate();
      return { published: true };
    },
  });
  assert.deepEqual(result.addedRoutes, []);
  assert.deepEqual(result.removedRoutes, [`${baseModel}-via-together`]);
  assert.equal(readOpenRouterProviderVariants().sourceVersion, 2);
});

test("setOpenRouterProviders rejects an unregistered no-op but can clear an inactive base", async () => {
  await assert.rejects(
    setOpenRouterProviders("openrouter/not-registered", {
      providerOrder: [],
      allowFallbacks: true,
    }, {
      modelBySlug: new Map(),
      models: [],
      transact: async () => assert.fail("an invalid no-op must not start a transaction"),
    }),
    /registered OpenRouter Chat Completions base model/,
  );

  writeOpenRouterProviderVariants([{
    baseModel,
    providerOrder: [{ providerSlug: "together", providerName: "Together AI" }],
    allowFallbacks: true,
  }]);
  const result = await setOpenRouterProviders(baseModel, {
    providerOrder: [],
    allowFallbacks: true,
  }, {
    modelBySlug: new Map(),
    models: [],
    transact: async ({ mutate }) => {
      await mutate();
      return { published: true };
    },
  });
  assert.deepEqual(result.removedRoutes, [`${baseModel}-via-together`]);
  assert.deepEqual(readOpenRouterProviderVariants().variants, []);
});

test("setOpenRouterProviders restores the ordered chain when publication fails", async () => {
  writeOpenRouterProviderVariants([{
    baseModel,
    providerOrder: [{ providerSlug: "deepinfra", providerName: "DeepInfra" }],
    allowFallbacks: true,
  }]);
  let publications = 0;
  await assert.rejects(
    setOpenRouterProviders(baseModel, {
      providerOrder: ["together", "deepinfra"],
      allowFallbacks: false,
    }, {
      discover: async () => liveProviders(),
      transact: (options) => transactModelOverlayMutation({
        ...options,
        lock: false,
        applyPublication: async () => {
          publications += 1;
          if (publications === 1) throw new Error("fixture publication failure");
          return { published: true, restarted: true };
        },
      }),
    }),
    /fixture publication failure/,
  );
  assert.equal(publications, 2, "rollback republishes the restored state");
  assert.deepEqual(readOpenRouterProviderVariants().variants, [{
    baseModel,
    providerOrder: [{ providerSlug: "deepinfra", providerName: "DeepInfra" }],
    allowFallbacks: true,
  }]);
});

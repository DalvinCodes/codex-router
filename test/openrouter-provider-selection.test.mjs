import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "openrouter-provider-selection-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const { setOpenRouterProviders } = await import("../src/openrouter-provider-selection.mjs");
const { readVisibleModels } = await import("../src/model-picker-state.mjs");
const { transactModelOverlayMutation } = await import("../src/model-overlay-publication.mjs");
const {
  readOpenRouterProviderVariants,
  writeOpenRouterProviderVariants,
} = await import("../src/openrouter-provider-variants.mjs");

const baseModel = "openrouter/deepseek-v4.1-flash";

function liveProviders() {
  return {
    modelSlug: baseModel,
    providers: [{
      slug: "deepinfra",
      name: "DeepInfra",
      endpointCount: 2,
      quantizations: ["fp8"],
      available: true,
      advertised: true,
      selected: false,
    }],
    cached: false,
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

test("setOpenRouterProviders freshly validates, publishes, and selects a derived route", async () => {
  const discoveries = [];
  const result = await setOpenRouterProviders(baseModel, ["deepinfra", "deepinfra"], {
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
  assert.deepEqual(result.addedRoutes, [`${baseModel}-via-deepinfra`]);
  assert.deepEqual(result.removedRoutes, []);
  assert.deepEqual(readOpenRouterProviderVariants().variants, [{
    baseModel,
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
    allowFallbacks: true,
  }]);
  assert.equal(readVisibleModels().has(`${baseModel}-via-deepinfra`), true);
});

test("setOpenRouterProviders persists an explicit without-fallbacks policy", async () => {
  const result = await setOpenRouterProviders(baseModel, [{
    providerSlug: "deepinfra",
    allowFallbacks: false,
  }], {
    discover: async () => liveProviders(),
    transact: async ({ mutate }) => {
      await mutate();
      return { published: true, restarted: true };
    },
  });
  assert.deepEqual(result.addedRoutes, []);
  assert.deepEqual(result.removedRoutes, []);
  assert.deepEqual(readOpenRouterProviderVariants().variants, [{
    baseModel,
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
    allowFallbacks: false,
  }]);
});

test("setOpenRouterProviders rejects conflicting policies for one provider", async () => {
  await assert.rejects(
    setOpenRouterProviders(baseModel, [
      { providerSlug: "deepinfra", allowFallbacks: true },
      { providerSlug: "deepinfra", allowFallbacks: false },
    ], {
      discover: async () => assert.fail("invalid selections must fail before discovery"),
    }),
    /conflicting fallback policies/,
  );
});

test("setOpenRouterProviders refuses a concurrent same-model selection change", async () => {
  await assert.rejects(
    setOpenRouterProviders(baseModel, ["deepinfra"], {
      discover: async () => liveProviders(),
      transact: async ({ mutate }) => {
        writeOpenRouterProviderVariants([{
          baseModel,
          providerSlug: "together",
          providerName: "Together AI",
          allowFallbacks: true,
        }]);
        await mutate();
      },
    }),
    /changed while this update was pending/,
  );
});

test("setOpenRouterProviders rejects an unregistered no-op but can clear an inactive base", async () => {
  await assert.rejects(
    setOpenRouterProviders("openrouter/not-registered", [], {
      modelBySlug: new Map(),
      models: [],
      transact: async () => assert.fail("an invalid no-op must not start a transaction"),
    }),
    /registered OpenRouter Chat Completions base model/,
  );

  const result = await setOpenRouterProviders(baseModel, [], {
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

test("setOpenRouterProviders restores selection state when publication fails", async () => {
  writeOpenRouterProviderVariants([{
    baseModel,
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
    allowFallbacks: true,
  }]);
  let publications = 0;
  await assert.rejects(
    setOpenRouterProviders(baseModel, ["together"], {
      discover: async () => ({
        ...liveProviders(),
        providers: [{
          slug: "together",
          name: "Together AI",
          endpointCount: 1,
          quantizations: ["fp16"],
          available: true,
          advertised: true,
          selected: false,
        }],
      }),
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
    providerSlug: "deepinfra",
    providerName: "DeepInfra",
    allowFallbacks: true,
  }]);
});

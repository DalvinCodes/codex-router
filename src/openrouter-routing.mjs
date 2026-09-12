// Apply a derived OpenRouter route's deterministic downstream preference at
// the last request boundary. Returning whether the body changed makes the
// wire contract independently testable without starting the forwarding
// service or making a live provider request.
export function applyOpenRouterProviderRouting(payload, model, route) {
  if (
    route !== "/chat/completions" ||
    model?.provider !== "openrouter" ||
    !model.openrouterRouting
  ) return false;
  payload.provider = {
    order: [model.openrouterRouting.providerSlug],
    allow_fallbacks: model.openrouterRouting.allowFallbacks,
  };
  return true;
}

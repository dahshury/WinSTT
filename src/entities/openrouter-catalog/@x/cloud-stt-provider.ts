// Cross-entity surface for the `cloud-stt-provider` entity: its OpenRouter
// transcription-catalog store is built from the shared factory here. Per FSD
// ref-public-api-04, peer entities must talk through @x/ rather than the public
// index.
export { createOpenRouterCatalogStore } from "../model/create-openrouter-catalog-store";

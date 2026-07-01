// Cross-entity surface for the `llm-catalog` entity: its richer OpenRouter and
// Ollama stores reuse the shared scan-state reducers here rather than
// re-declaring them. Per FSD ref-public-api-04, peer entities must talk through
// @x/ rather than the public index.
export {
	makeScanErrorState,
	makeScanSuccessState,
} from "../model/create-openrouter-catalog-store";

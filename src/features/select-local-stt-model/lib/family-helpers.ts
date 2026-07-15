// Re-export the shared synthetic-group value so STT call sites keep importing it
// from family-helpers unchanged (the canonical definition now lives in core).
export { FAVORITES_GROUP_VALUE } from "@/shared/ui/model-picker/core/favorites";
export {
	getAuthorLabel,
	getFamilyConfig,
	buildModelSearchCorpus,
	type FamilyKey,
	variantDisplayName,
} from "@/entities/model-catalog";
export * from "./family-grouping";
export * from "./family-variant-bundle";

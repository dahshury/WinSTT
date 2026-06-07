// Re-export the shared synthetic-group value so STT call sites keep importing it
// from family-helpers unchanged (the canonical definition now lives in core).
export { FAVORITES_GROUP_VALUE } from "../../core/favorites";
export * from "./family-display-name";
export * from "./family-grouping";
export * from "./family-metadata";
export * from "./family-variant-bundle";

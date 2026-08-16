// Exported so consumers that must ANSWER "what breaks if this key is removed"
// (the Integrations tab's capability chips) can ask the planner itself instead
// of restating its rules and drifting from it.
export {
	type ClearableProvider,
	planReverts,
	type RevertPlan,
	type SurfaceSnapshot,
} from "./model/cloud-revert-decision";
export {
	revertSurfacesForClearedProvider,
	useCloudKeyAutoRevert,
} from "./model/use-cloud-key-auto-revert";
export { useCloudOfflineAutoRevert } from "./model/use-cloud-offline-auto-revert";
export { CloudKeyRevertNotice } from "./ui/CloudKeyRevertNotice";

// Cross-entity surface for the `cloud-stt-credential` entity:
// it needs to subscribe to settings to clear stale verification status
// whenever an API key changes. Per FSD Rref-public-api-04, peer entities
// must talk through @x/ rather than the public index.
export { useSettingsStore } from "../model/settings-store";

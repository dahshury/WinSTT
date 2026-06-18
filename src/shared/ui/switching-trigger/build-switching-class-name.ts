/** Suffix appended to a trigger's base className. Centralizes the
 *  disabled-opacity rule (override to full when switching, otherwise 50% as
 *  the disabled default) plus the accent tint that signals "active swap". */
export function buildSwitchingClassName(isSwitching: boolean): string {
	return isSwitching
		? "from-accent-wash! to-surface-2/95! opacity-100! ring-accent/40!"
		: "disabled:opacity-50";
}

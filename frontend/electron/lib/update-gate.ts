/**
 * Update-signature gating policy (extracted from main.ts so it is unit-testable).
 *
 * A minisign verification of a downloaded update can fail for two very different
 * reasons, and they must be handled in OPPOSITE ways:
 *   - The check could not RUN — our pubkey is missing, or the `.minisig` sidecar
 *     returned 404/410. Authenticode still gates the installer, so we FAIL OPEN
 *     (let the update proceed).
 *   - The check ran and the signature was REJECTED (any other reason). Treat the
 *     artifact as tampered and FAIL CLOSED (delete it, block install).
 */
export function isFailOpenUpdateReason(reason: string): boolean {
	return (
		reason.includes("pubkey not found") ||
		reason.includes("HTTP 404") ||
		reason.includes("HTTP 410")
	);
}

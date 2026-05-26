/**
 * Apple Intelligence platform classification (renderer-side).
 *
 * The renderer needs to know three things about the host:
 *   - Is this macOS at all?
 *   - If yes, is it Apple Silicon (arm64) vs Intel (x86_64)?
 *
 * The Electron main process knows this from `process.platform` /
 * `process.arch` natively, but the renderer can't read those directly
 * (they're undefined in a sandboxed renderer). We classify from
 * `navigator.userAgent` / `navigator.platform` instead — the same data
 * any web app would use.
 *
 * This is a UI-only signal — the actual runtime gate lives in
 * `electron/ipc/apple-intelligence.ts` (which uses `process.platform` /
 * `process.arch` for ground truth). The classifier here is "good
 * enough" to drive the picker visibility / tooltip; if a user
 * somehow picks Apple Intelligence on a misclassified host, the IPC
 * layer rejects the call cleanly.
 */

export type AppleIntelligencePlatform = "apple-silicon" | "intel-mac" | "other";

interface ClassifyOpts {
	platform?: string;
	userAgent?: string;
}

/**
 * Map (platform, userAgent) to one of three buckets. Pure function — no
 * `navigator` access — so the tests can drive it with synthetic strings.
 *
 * Detection rules:
 *   - "Mac" appears in either string ⇒ macOS host.
 *   - On a Mac, look for "ARM" / "Apple Silicon" / "arm64" tokens to
 *     classify as Apple Silicon. macOS Safari/Chrome on Apple Silicon
 *     include "Mac OS X" + "Intel" in the UA string for compatibility
 *     reasons (legacy Intel UA), but Electron's userAgent on Apple
 *     Silicon includes "Electron" without lying about the architecture.
 *     We additionally accept `navigator.userAgentData` (Client Hints)
 *     if the caller passes a pre-flattened hint string.
 */
export function classifyAppleIntelligencePlatform(opts: ClassifyOpts): AppleIntelligencePlatform {
	const platform = (opts.platform ?? "").toLowerCase();
	const userAgent = (opts.userAgent ?? "").toLowerCase();
	const isMac =
		platform.includes("mac") || userAgent.includes("mac os") || userAgent.includes("macos");
	if (!isMac) {
		return "other";
	}
	const archSignal = `${platform} ${userAgent}`;
	const looksAppleSilicon = archSignal.includes("arm") || archSignal.includes("apple silicon");
	return looksAppleSilicon ? "apple-silicon" : "intel-mac";
}

/**
 * Detect from the current renderer's `navigator`. Returns "other" in any
 * non-browser context (e.g. Bun test runner without a DOM) so consumers
 * default to hiding the option safely.
 */
export function detectAppleIntelligencePlatform(): AppleIntelligencePlatform {
	if (typeof navigator === "undefined") {
		return "other";
	}
	const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
	const userAgentDataPlatform = nav.userAgentData?.platform ?? "";
	return classifyAppleIntelligencePlatform({
		platform: `${nav.platform ?? ""} ${userAgentDataPlatform}`,
		userAgent: nav.userAgent ?? "",
	});
}

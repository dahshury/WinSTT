/**
 * Apple Intelligence platform classification (renderer-side).
 *
 * The renderer needs to know three things about the host:
 *   - Is this macOS at all?
 *   - If yes, is it Apple Silicon (arm64) vs Intel (x86_64)?
 *
 * Tauri exposes the compiled host OS and architecture synchronously through
 * `@tauri-apps/plugin-os`. Prefer that ground truth: Chromium intentionally
 * reports `MacIntel` on Apple Silicon for compatibility, so navigator-only
 * sniffing falsely classifies real M-series Macs as Intel.
 *
 * This is a UI-only signal — the actual runtime gate lives in the main
 * process (which uses `process.platform` / `process.arch` for ground truth).
 * The classifier here is "good
 * enough" to drive the picker visibility / tooltip; if a user
 * somehow picks Apple Intelligence on a misclassified host, the IPC
 * layer rejects the call cleanly.
 */

import { arch, platform as osPlatform } from "@tauri-apps/plugin-os";

export type AppleIntelligencePlatform = "apple-silicon" | "intel-mac" | "other";

interface ClassifyOpts {
	architecture?: string;
	platform?: string;
	userAgent?: string;
}

/**
 * "Mac" appears in either string ⇒ macOS host. Both inputs are expected
 * pre-lowercased. Extracted so the top-level classifier reads as a flat
 * decision (mac? → arch?) instead of inlining the OR-chains.
 */
function detectMac(platform: string, userAgent: string): boolean {
	return (
		platform.includes("mac") ||
		userAgent.includes("mac os") ||
		userAgent.includes("macos")
	);
}

/**
 * On a Mac, look for "ARM" / "Apple Silicon" / "arm64" tokens to classify
 * as Apple Silicon. macOS Safari/Chrome on Apple Silicon include
 * "Mac OS X" + "Intel" in the UA string for compatibility reasons (legacy
 * Intel UA), so we look for explicit "arm" / "apple silicon" tokens
 * rather than trusting the legacy "Intel" string. We additionally accept
 * `navigator.userAgentData` (Client Hints) if the caller passes a
 * pre-flattened hint string. Both inputs are expected pre-lowercased.
 */
function detectAppleSilicon(
	architecture: string,
	platform: string,
	userAgent: string,
): boolean {
	const archSignal = `${architecture} ${platform} ${userAgent}`;
	return (
		archSignal.includes("arm") ||
		archSignal.includes("aarch64") ||
		archSignal.includes("apple silicon")
	);
}

/**
 * Map (platform, userAgent) to one of three buckets. Pure function — no
 * `navigator` access — so the tests can drive it with synthetic strings.
 */
export function classifyAppleIntelligencePlatform(
	opts: ClassifyOpts,
): AppleIntelligencePlatform {
	const platform = (opts.platform ?? "").toLowerCase();
	const userAgent = (opts.userAgent ?? "").toLowerCase();
	const architecture = (opts.architecture ?? "").toLowerCase();
	if (!detectMac(platform, userAgent)) {
		return "other";
	}
	return detectAppleSilicon(architecture, platform, userAgent)
		? "apple-silicon"
		: "intel-mac";
}

/**
 * Detect from the current renderer's `navigator`. Returns "other" in any
 * non-browser context (e.g. Bun test runner without a DOM) so consumers
 * default to hiding the option safely.
 */
export function detectAppleIntelligencePlatform(): AppleIntelligencePlatform {
	try {
		return classifyAppleIntelligencePlatform({
			architecture: arch(),
			platform: osPlatform(),
		});
	} catch {
		// Plain-browser/test fallback. A Tauri renderer always takes the branch
		// above; this keeps the pure helper usable without injected plugin globals.
	}
	if (typeof navigator === "undefined") {
		return "other";
	}
	const nav = navigator as Navigator & {
		userAgentData?: { platform?: string };
	};
	const userAgentDataPlatform = nav.userAgentData?.platform ?? "";
	return classifyAppleIntelligencePlatform({
		platform: `${nav.platform ?? ""} ${userAgentDataPlatform}`,
		userAgent: nav.userAgent ?? "",
	});
}

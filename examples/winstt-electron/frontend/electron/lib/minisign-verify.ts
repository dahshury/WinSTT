/**
 * Minisign signature verification for WinSTT auto-updates.
 *
 * Implements just enough of the {@link https://jedisct1.github.io/minisign/
 * minisign} format to verify a release-artifact signature offline using
 * Node's built-in Ed25519 — no third-party dependency.
 *
 * ## Format reference
 *
 * A `.minisig` sidecar is a small text file with this shape:
 *
 *     untrusted comment: signature from minisign secret key
 *     RWS<base64-encoded sig blob, 74 bytes>
 *     trusted comment: WinSTT release v0.4.0 — WinSTT-Portable-0.4.0.exe
 *     <base64-encoded global signature, 64 bytes>
 *
 * The signature blob layout:
 *
 *     bytes 0-1   sig algorithm tag: "Ed" (raw Ed25519) or "ED" (BLAKE2b-then-Ed25519, --hash mode)
 *     bytes 2-9   key id (8 bytes; must match the embedded id in the .pub)
 *     bytes 10-73 Ed25519 signature over the artifact bytes
 *
 * The "global signature" at the end signs `signature ‖ trusted_comment` so
 * the trusted comment can be relied on. We verify both.
 *
 * The matching public-key file (`docs/winstt.pub`) is the same shape:
 *
 *     untrusted comment: minisign public key …
 *     RWS<base64-encoded blob, 42 bytes>
 *
 * Blob: `Ed` (2 bytes) ‖ key_id (8 bytes) ‖ pubkey (32 bytes Ed25519).
 *
 * ## Scope
 *
 * We only support raw Ed25519 mode (`Ed`), not the legacy hashed mode
 * (`ED`). The release workflow at `.github/workflows/electron-release.yml`
 * calls `minisign -S` without `-H`, which produces `Ed` exclusively. If a
 * future maintainer flips to hashed mode, this function returns a clear
 * "unsupported signature algorithm" error rather than silently passing.
 *
 * Intentionally no progress / fetch retries here — the auto-updater
 * itself handles the artifact download; we only fetch the sidecar
 * (~250 bytes) and verify locally.
 */

import { createHash, verify as cryptoVerify } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename } from "node:path";

/**
 * 2-byte signature algorithm prefix at the start of every minisign blob.
 * We accept raw Ed25519 only — see module docstring.
 */
const SIG_ALG_ED25519 = Buffer.from("Ed", "ascii");

/** Length of the embedded Ed25519 signature inside a minisign signature blob. */
const ED25519_SIG_BYTES = 64;

/** Length of an Ed25519 public-key blob (after the 2-byte algo + 8-byte key id). */
const ED25519_PUB_BYTES = 32;

/** Length of the key-id field that pairs a pubkey with its signature. */
const KEY_ID_BYTES = 8;

// Top-level regex so Biome's `useTopLevelRegex` is satisfied AND so
// repeated parses don't recompile the pattern. Tolerates both LF and CRLF
// line endings — minisign sidecars produced on Windows often carry CRLF.
const LINE_SPLIT_RE = /\r?\n/;

export interface MinisignPubkey {
	readonly keyId: Buffer;
	readonly pubkey: Buffer;
}

export interface MinisignSignature {
	readonly globalSignature: Buffer;
	readonly keyId: Buffer;
	readonly signature: Buffer;
	readonly trustedComment: string;
}

export type VerifyResult =
	| { readonly ok: true; readonly trustedComment: string }
	| { readonly ok: false; readonly reason: string };

/**
 * Parse a minisign public-key file. Tolerant of CRLF and trailing
 * whitespace; rejects the wrong number of decoded bytes so a truncated
 * file fails before the verify call.
 */
export function parseMinisignPubkey(text: string): MinisignPubkey {
	const lines = text.split(LINE_SPLIT_RE).filter((l) => l.length > 0);
	const dataLine = lines.find((l) => !l.startsWith("untrusted comment:"));
	if (!dataLine) {
		throw new Error("minisign pubkey: no data line found");
	}
	const raw = Buffer.from(dataLine.trim(), "base64");
	const expected = SIG_ALG_ED25519.length + KEY_ID_BYTES + ED25519_PUB_BYTES;
	if (raw.length !== expected) {
		throw new Error(
			`minisign pubkey: expected ${expected} bytes, got ${raw.length} — keyfile is corrupt or not the right shape`
		);
	}
	if (raw.subarray(0, SIG_ALG_ED25519.length).compare(SIG_ALG_ED25519) !== 0) {
		throw new Error("minisign pubkey: unsupported signature algorithm (expected raw Ed25519)");
	}
	return {
		keyId: raw.subarray(SIG_ALG_ED25519.length, SIG_ALG_ED25519.length + KEY_ID_BYTES),
		pubkey: raw.subarray(SIG_ALG_ED25519.length + KEY_ID_BYTES),
	};
}

interface MinisignSidecarLines {
	globalSigLine: string;
	sigLine: string;
	trustedComment: string;
}

/**
 * Scan a `.minisig` text into its three meaningful lines. Layout: [0]
 * untrusted comment, [1] sig blob, [2] trusted comment line, [3] global sig,
 * optional trailing newline. Tolerates extra blank lines by indexing the
 * first matching line of each kind. Throws when any required line is absent.
 */
function scanSidecarLines(text: string): MinisignSidecarLines {
	let sigLine: string | undefined;
	let trustedComment: string | undefined;
	let globalSigLine: string | undefined;
	for (const rawLine of text.split(LINE_SPLIT_RE)) {
		const l = rawLine.trim();
		if (l.length === 0 || l.startsWith("untrusted comment:")) {
			continue;
		}
		if (l.startsWith("trusted comment:")) {
			trustedComment = l.slice("trusted comment:".length).trim();
		} else if (sigLine === undefined) {
			// First non-comment line = artifact signature.
			sigLine = l;
		} else if (trustedComment !== undefined && globalSigLine === undefined) {
			// Second non-comment line, after the trusted comment = global sig.
			globalSigLine = l;
		}
	}
	if (!sigLine) {
		throw new Error("minisign signature: artifact signature line not found");
	}
	if (trustedComment === undefined) {
		throw new Error("minisign signature: 'trusted comment:' line not found");
	}
	if (!globalSigLine) {
		throw new Error("minisign signature: global signature line not found");
	}
	return { sigLine, trustedComment, globalSigLine };
}

/**
 * Decode + validate the artifact signature blob: exactly
 * (algo ‖ key id ‖ Ed25519 sig) bytes, raw-Ed25519 algorithm only. Throws a
 * specific error for a corrupt length vs. an unsupported hashed-mode tag.
 */
function decodeSignatureBlob(sigLine: string): Buffer {
	const sigRaw = Buffer.from(sigLine, "base64");
	const expected = SIG_ALG_ED25519.length + KEY_ID_BYTES + ED25519_SIG_BYTES;
	if (sigRaw.length !== expected) {
		throw new Error(
			`minisign signature: expected ${expected} bytes, got ${sigRaw.length} — sidecar is corrupt`
		);
	}
	if (sigRaw.subarray(0, SIG_ALG_ED25519.length).compare(SIG_ALG_ED25519) !== 0) {
		throw new Error(
			"minisign signature: hashed-mode signatures ('ED') are not supported — re-sign without -H"
		);
	}
	return sigRaw;
}

/**
 * Parse a `.minisig` signature file. Returns the artifact signature,
 * the trusted comment, and the global signature that covers the
 * (signature ‖ trustedComment) pair.
 */
export function parseMinisignSignature(text: string): MinisignSignature {
	const { sigLine, trustedComment, globalSigLine } = scanSidecarLines(text);
	const sigRaw = decodeSignatureBlob(sigLine);
	const globalSignature = Buffer.from(globalSigLine, "base64");
	if (globalSignature.length !== ED25519_SIG_BYTES) {
		throw new Error(
			`minisign global signature: expected ${ED25519_SIG_BYTES} bytes, got ${globalSignature.length}`
		);
	}
	return {
		keyId: sigRaw.subarray(SIG_ALG_ED25519.length, SIG_ALG_ED25519.length + KEY_ID_BYTES),
		signature: sigRaw.subarray(SIG_ALG_ED25519.length + KEY_ID_BYTES),
		trustedComment,
		globalSignature,
	};
}

/**
 * Ed25519 verify wrapper that hides the Node "key object" plumbing. We
 * accept the 32-byte raw public key (as embedded in the .pub file) and
 * import it as an SPKI DER on the fly — Node's `crypto.verify` requires
 * a `KeyObject` / PEM rather than a raw buffer.
 *
 * The SPKI wrapper for Ed25519 is a fixed 12-byte prefix
 * (`30 2A 30 05 06 03 2B 65 70 03 21 00`) followed by the 32-byte key.
 */
function ed25519Verify(message: Buffer, signature: Buffer, rawPubkey: Buffer): boolean {
	if (rawPubkey.length !== ED25519_PUB_BYTES) {
		return false;
	}
	const spki = Buffer.concat([
		Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
		rawPubkey,
	]);
	const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString("base64")}\n-----END PUBLIC KEY-----`;
	return cryptoVerify(null, message, pem, signature);
}

/**
 * Verify a (artifact, sidecar) pair against a minisign public key.
 * The artifact may be a Buffer (small files / tests) or a path to be
 * streamed; this overload variant keeps both flows from duplicating
 * the parsing + key-id check.
 */
export function verifyMinisignSignature(
	artifactBytes: Buffer,
	sigText: string,
	pubText: string
): VerifyResult {
	let pub: MinisignPubkey;
	let sig: MinisignSignature;
	try {
		pub = parseMinisignPubkey(pubText);
		sig = parseMinisignSignature(sigText);
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
	if (pub.keyId.compare(sig.keyId) !== 0) {
		return {
			ok: false,
			reason: `minisign key-id mismatch (sidecar=${sig.keyId.toString("hex")}, pub=${pub.keyId.toString("hex")}) — the artifact was signed with a different key than the bundled pubkey expects`,
		};
	}
	if (!ed25519Verify(artifactBytes, sig.signature, pub.pubkey)) {
		return { ok: false, reason: "Ed25519 signature does not match the artifact bytes" };
	}
	// The "global signature" covers signature ‖ trustedComment so the
	// trusted comment line itself is trustworthy. Verifying it isn't
	// strictly required for safety (the artifact signature above is the
	// real trust anchor) but mirrors what `minisign -V` does and lets us
	// safely display the trustedComment to the user.
	const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
	if (!ed25519Verify(globalMessage, sig.globalSignature, pub.pubkey)) {
		return {
			ok: false,
			reason: "global signature does not match (trusted comment may have been tampered with)",
		};
	}
	return { ok: true, trustedComment: sig.trustedComment };
}

/**
 * High-level helper for the auto-updater hook: load an artifact from
 * disk, fetch its `.minisig` sidecar from a URL, and verify both
 * against a bundled pubkey. Pure I/O; the actual crypto lives in the
 * unit-testable {@link verifyMinisignSignature} above.
 *
 * Returns `{ ok: true }` when the artifact is genuine; otherwise the
 * caller MUST refuse the install and surface the reason to the user.
 *
 * The pubkey path is optional: when missing (e.g. before the
 * maintainer has generated and committed `docs/winstt.pub`), we return
 * `{ ok: false, reason: "no pubkey configured" }` and the caller
 * decides whether to fail-open (warn-and-allow) or fail-closed (block).
 * The auto-updater hook in main.ts treats this as "verification
 * unavailable — fall back to Authenticode only" so a maintainer who
 * hasn't shipped a pubkey yet doesn't accidentally break self-updates.
 */
export interface VerifyDownloadedUpdateInput {
	readonly artifactPath: string;
	readonly pubkeyPath: string;
	readonly sidecarUrl: string;
}

/** Normalize a thrown value to a printable message string. */
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Fetch the `.minisig` sidecar text. Returns a `VerifyResult` failure (never
 * throws) so the orchestrator below stays a flat sequence of guarded steps —
 * HTTP-error and network-error paths produce distinct, user-facing reasons.
 */
async function fetchSidecarText(
	sidecarUrl: string
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
	try {
		const response = await fetch(sidecarUrl);
		if (!response.ok) {
			return {
				ok: false,
				reason: `failed to fetch .minisig sidecar (HTTP ${response.status} ${response.statusText}) — release ${basename(sidecarUrl)} likely wasn't signed`,
			};
		}
		return { ok: true, text: await response.text() };
	} catch (e) {
		return { ok: false, reason: `failed to fetch .minisig sidecar: ${errMsg(e)}` };
	}
}

export async function verifyDownloadedUpdate({
	artifactPath,
	sidecarUrl,
	pubkeyPath,
}: VerifyDownloadedUpdateInput): Promise<VerifyResult> {
	let pubText: string;
	try {
		pubText = await fs.readFile(pubkeyPath, "utf8");
	} catch (e) {
		return { ok: false, reason: `pubkey not found at ${pubkeyPath} (${errMsg(e)})` };
	}

	const sidecar = await fetchSidecarText(sidecarUrl);
	if (!sidecar.ok) {
		return sidecar;
	}

	let artifactBytes: Buffer;
	try {
		artifactBytes = await fs.readFile(artifactPath);
	} catch (e) {
		return {
			ok: false,
			reason: `failed to read downloaded artifact at ${artifactPath}: ${errMsg(e)}`,
		};
	}

	return verifyMinisignSignature(artifactBytes, sidecar.text, pubText);
}

/**
 * SHA-256 helper for diagnostic logging — not part of the verify chain.
 * Used by the auto-updater hook to print the artifact digest alongside
 * verification results so a curious user can compare to the GitHub
 * release's expected hash.
 */
export function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

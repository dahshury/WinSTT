import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type createPrivateKey, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	parseMinisignPubkey,
	parseMinisignSignature,
	sha256,
	verifyMinisignSignature,
} from "./minisign-verify";

// ─── Helpers ─────────────────────────────────────────────────────────────
//
// minisign's blob layout is fixed-width binary wrapping raw Ed25519 keys +
// signatures. We synthesize valid (and invalid) blobs in-process so the
// tests are hermetic — no `minisign` binary required, no fixture files.

const SIG_ALG_ED25519 = Buffer.from("Ed", "ascii");
const ED25519_SIG_BYTES = 64;
const ED25519_PUB_BYTES = 32;
const KEY_ID_BYTES = 8;

// SPKI prefix for Ed25519 — used by Node's key-import to peel out the raw
// 32-byte public key from a generated keypair.
const ED25519_SPKI_PREFIX_BYTES = 12;

interface GeneratedKey {
	readonly keyId: Buffer;
	readonly privKey: ReturnType<typeof createPrivateKey>;
	readonly pubText: string;
	readonly rawPub: Buffer;
}

let KEY_ID_COUNTER = 0;

function generateMinisignKey(): GeneratedKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
	const rawPub = spki.subarray(ED25519_SPKI_PREFIX_BYTES);
	const keyId = Buffer.alloc(KEY_ID_BYTES);
	// Distinct id per generated key so collision-free mismatch tests work
	// regardless of generation order.
	KEY_ID_COUNTER += 1;
	keyId.writeUInt32BE(KEY_ID_COUNTER, 0);
	keyId.writeUInt32BE(KEY_ID_COUNTER, 4);
	const blob = Buffer.concat([SIG_ALG_ED25519, keyId, rawPub]);
	const pubText = `untrusted comment: test\n${blob.toString("base64")}\n`;
	return { keyId, rawPub, pubText, privKey: privateKey };
}

function signArtifact(
	artifact: Buffer,
	priv: ReturnType<typeof createPrivateKey>,
	keyId: Buffer,
	trustedComment: string
): string {
	const sig = cryptoSign(null, artifact, priv);
	const sigBlob = Buffer.concat([SIG_ALG_ED25519, keyId, sig]);
	const globalMsg = Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]);
	const globalSig = cryptoSign(null, globalMsg, priv);
	return [
		"untrusted comment: test sig",
		sigBlob.toString("base64"),
		`trusted comment: ${trustedComment}`,
		globalSig.toString("base64"),
		"",
	].join("\n");
}

// Reusable keypair so every test doesn't pay the keygen cost.
let GLOBAL_KEY: GeneratedKey;
beforeAll(() => {
	GLOBAL_KEY = generateMinisignKey();
});

/**
 * Replace `globalThis.fetch` with a stub that ignores the request. Avoids
 * the `typeof fetch` requires-`preconnect` TS error by casting through
 * `unknown` once.
 */
function stubFetch(handler: () => Promise<Response>): void {
	(globalThis as unknown as { fetch: unknown }).fetch = handler;
}

// ─── parseMinisignPubkey ─────────────────────────────────────────────────

describe("parseMinisignPubkey", () => {
	test("parses a valid pubkey blob", () => {
		const parsed = parseMinisignPubkey(GLOBAL_KEY.pubText);
		expect(parsed.keyId.length).toBe(KEY_ID_BYTES);
		expect(parsed.pubkey.length).toBe(ED25519_PUB_BYTES);
		expect(parsed.keyId.compare(GLOBAL_KEY.keyId)).toBe(0);
		expect(parsed.pubkey.compare(GLOBAL_KEY.rawPub)).toBe(0);
	});

	test("tolerates CRLF line endings", () => {
		const crlf = GLOBAL_KEY.pubText.replace(/\n/g, "\r\n");
		expect(() => parseMinisignPubkey(crlf)).not.toThrow();
	});

	test("rejects pubkey with no data line", () => {
		expect(() => parseMinisignPubkey("untrusted comment: only\n")).toThrow(/no data line/);
	});

	test("rejects pubkey with wrong byte length", () => {
		const truncated = `untrusted comment: x\n${Buffer.from("xx").toString("base64")}\n`;
		expect(() => parseMinisignPubkey(truncated)).toThrow(/keyfile is corrupt/);
	});

	test("rejects pubkey with non-Ed algorithm tag", () => {
		const fake = Buffer.concat([Buffer.from("XX", "ascii"), GLOBAL_KEY.keyId, GLOBAL_KEY.rawPub]);
		const text = `untrusted comment: x\n${fake.toString("base64")}\n`;
		expect(() => parseMinisignPubkey(text)).toThrow(/unsupported signature algorithm/);
	});
});

// ─── parseMinisignSignature ──────────────────────────────────────────────

describe("parseMinisignSignature", () => {
	test("parses a valid sidecar", () => {
		const sigText = signArtifact(
			Buffer.from("hello"),
			GLOBAL_KEY.privKey,
			GLOBAL_KEY.keyId,
			"v1.2.3 — installer.exe"
		);
		const parsed = parseMinisignSignature(sigText);
		expect(parsed.signature.length).toBe(ED25519_SIG_BYTES);
		expect(parsed.globalSignature.length).toBe(ED25519_SIG_BYTES);
		expect(parsed.keyId.compare(GLOBAL_KEY.keyId)).toBe(0);
		expect(parsed.trustedComment).toBe("v1.2.3 — installer.exe");
	});

	test("rejects sidecar with no signature line", () => {
		expect(() => parseMinisignSignature("untrusted comment: x\ntrusted comment: y\n")).toThrow();
	});

	test("rejects sidecar with hashed-mode (ED) signature", () => {
		const fakeSig = Buffer.concat([
			Buffer.from("ED", "ascii"),
			GLOBAL_KEY.keyId,
			Buffer.alloc(ED25519_SIG_BYTES),
		]);
		const text = [
			"untrusted comment: sig",
			fakeSig.toString("base64"),
			"trusted comment: x",
			Buffer.alloc(ED25519_SIG_BYTES).toString("base64"),
			"",
		].join("\n");
		expect(() => parseMinisignSignature(text)).toThrow(/hashed-mode/);
	});

	test("rejects sidecar with corrupt sig length", () => {
		const text = [
			"untrusted comment: sig",
			Buffer.from("not-a-real-sig").toString("base64"),
			"trusted comment: x",
			Buffer.alloc(ED25519_SIG_BYTES).toString("base64"),
			"",
		].join("\n");
		expect(() => parseMinisignSignature(text)).toThrow(/sidecar is corrupt/);
	});
});

// ─── verifyMinisignSignature ─────────────────────────────────────────────

describe("verifyMinisignSignature", () => {
	test("returns ok:true for a genuine artifact + sidecar + pub triple", () => {
		const artifact = Buffer.from("the installer bytes");
		const sigText = signArtifact(artifact, GLOBAL_KEY.privKey, GLOBAL_KEY.keyId, "WinSTT v0.4.0");
		const result = verifyMinisignSignature(artifact, sigText, GLOBAL_KEY.pubText);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.trustedComment).toBe("WinSTT v0.4.0");
		}
	});

	test("returns ok:false when the artifact bytes are tampered", () => {
		const artifact = Buffer.from("original");
		const sigText = signArtifact(artifact, GLOBAL_KEY.privKey, GLOBAL_KEY.keyId, "v1");
		const tampered = Buffer.from("modified");
		const result = verifyMinisignSignature(tampered, sigText, GLOBAL_KEY.pubText);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/Ed25519 signature does not match/);
		}
	});

	test("returns ok:false when the sidecar was signed by a different keypair", () => {
		const otherKey = generateMinisignKey();
		const artifact = Buffer.from("data");
		// sidecar uses otherKey to sign — but advertises GLOBAL_KEY.keyId
		// (sneaky); the pubkey blob is OUR key. Verify should fail on
		// signature mismatch (or key-id mismatch when keyId differs).
		const badSig = signArtifact(artifact, otherKey.privKey, GLOBAL_KEY.keyId, "v1");
		const result = verifyMinisignSignature(artifact, badSig, GLOBAL_KEY.pubText);
		expect(result.ok).toBe(false);
	});

	test("returns ok:false on key-id mismatch with descriptive reason", () => {
		const otherKey = generateMinisignKey();
		const artifact = Buffer.from("data");
		// Sidecar advertises otherKey's id; our pubkey blob has GLOBAL_KEY's id.
		const sigText = signArtifact(artifact, otherKey.privKey, otherKey.keyId, "v1");
		const result = verifyMinisignSignature(artifact, sigText, GLOBAL_KEY.pubText);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/key-id mismatch/);
		}
	});

	test("returns ok:false when trusted comment is tampered (global sig mismatch)", () => {
		const artifact = Buffer.from("data");
		const sigText = signArtifact(artifact, GLOBAL_KEY.privKey, GLOBAL_KEY.keyId, "v1");
		// Replace the trusted comment line with a different string. The
		// signature (over the artifact) still verifies — but the global
		// signature (which covers signature ‖ trustedComment) will not.
		const tampered = sigText.replace("trusted comment: v1", "trusted comment: v999");
		const result = verifyMinisignSignature(artifact, tampered, GLOBAL_KEY.pubText);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/global signature/);
		}
	});

	test("returns ok:false with parser error when sidecar is malformed", () => {
		const artifact = Buffer.from("data");
		const result = verifyMinisignSignature(artifact, "not a sidecar at all", GLOBAL_KEY.pubText);
		expect(result.ok).toBe(false);
	});
});

// ─── sha256 ──────────────────────────────────────────────────────────────

describe("sha256", () => {
	test("returns a 64-char hex string of the expected digest", () => {
		// sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
		expect(sha256(Buffer.from("hello"))).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
		);
	});

	test("differs for different inputs", () => {
		expect(sha256(Buffer.from("a"))).not.toBe(sha256(Buffer.from("b")));
	});
});

// ─── verifyDownloadedUpdate (I/O wrapper) ────────────────────────────────
//
// We test the orchestration layer by stubbing `globalThis.fetch` and
// using real on-disk artifact / pubkey files in an os.tmpdir(). This
// exercises the read-pubkey, fetch-sidecar, read-artifact, verify path.

describe("verifyDownloadedUpdate (orchestration)", () => {
	let tmpDir: string;
	const realFetch = globalThis.fetch;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minisign-test-"));
	});

	afterAll(async () => {
		globalThis.fetch = realFetch;
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
	});

	test("fails-open when pubkey is missing", async () => {
		const { verifyDownloadedUpdate } = await import("./minisign-verify");
		const result = await verifyDownloadedUpdate({
			artifactPath: path.join(tmpDir, "nope.exe"),
			pubkeyPath: path.join(tmpDir, "missing.pub"),
			sidecarUrl: "https://example.invalid/x.minisig",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/pubkey not found/);
		}
	});

	test("fails-open with HTTP-404-style reason when sidecar fetch fails", async () => {
		const pubPath = path.join(tmpDir, "ok.pub");
		await fs.writeFile(pubPath, GLOBAL_KEY.pubText);
		const artifactPath = path.join(tmpDir, "artifact.exe");
		await fs.writeFile(artifactPath, Buffer.from("data"));
		stubFetch(async () => new Response("Not Found", { status: 404, statusText: "Not Found" }));
		const { verifyDownloadedUpdate } = await import("./minisign-verify");
		const result = await verifyDownloadedUpdate({
			artifactPath,
			pubkeyPath: pubPath,
			sidecarUrl: "https://example.invalid/x.minisig",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/HTTP 404/);
		}
	});

	test("returns ok:true for a genuine artifact when sidecar fetch succeeds", async () => {
		const pubPath = path.join(tmpDir, "good.pub");
		await fs.writeFile(pubPath, GLOBAL_KEY.pubText);
		const artifactPath = path.join(tmpDir, "good.exe");
		const artifactBytes = Buffer.from("real installer bytes");
		await fs.writeFile(artifactPath, artifactBytes);
		const sigText = signArtifact(
			artifactBytes,
			GLOBAL_KEY.privKey,
			GLOBAL_KEY.keyId,
			"WinSTT v0.5.0"
		);
		stubFetch(async () => new Response(sigText, { status: 200, statusText: "OK" }));
		const { verifyDownloadedUpdate } = await import("./minisign-verify");
		const result = await verifyDownloadedUpdate({
			artifactPath,
			pubkeyPath: pubPath,
			sidecarUrl: "https://example.invalid/good.exe.minisig",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.trustedComment).toBe("WinSTT v0.5.0");
		}
	});

	test("returns ok:false when downloaded artifact is tampered", async () => {
		const pubPath = path.join(tmpDir, "tamp.pub");
		await fs.writeFile(pubPath, GLOBAL_KEY.pubText);
		const artifactPath = path.join(tmpDir, "tamp.exe");
		const originalBytes = Buffer.from("original installer bytes");
		const tamperedBytes = Buffer.from("tampered installer bytes");
		await fs.writeFile(artifactPath, tamperedBytes);
		// Sidecar was generated against ORIGINAL bytes — disk has TAMPERED.
		const sigText = signArtifact(originalBytes, GLOBAL_KEY.privKey, GLOBAL_KEY.keyId, "v1");
		stubFetch(async () => new Response(sigText, { status: 200, statusText: "OK" }));
		const { verifyDownloadedUpdate } = await import("./minisign-verify");
		const result = await verifyDownloadedUpdate({
			artifactPath,
			pubkeyPath: pubPath,
			sidecarUrl: "https://example.invalid/tamp.exe.minisig",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/Ed25519 signature does not match/);
		}
	});

	test("returns descriptive reason when artifact file is missing", async () => {
		const pubPath = path.join(tmpDir, "mia.pub");
		await fs.writeFile(pubPath, GLOBAL_KEY.pubText);
		stubFetch(async () => new Response("anything", { status: 200, statusText: "OK" }));
		const { verifyDownloadedUpdate } = await import("./minisign-verify");
		const result = await verifyDownloadedUpdate({
			artifactPath: path.join(tmpDir, "does-not-exist.exe"),
			pubkeyPath: pubPath,
			sidecarUrl: "https://example.invalid/x.minisig",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/failed to read downloaded artifact/);
		}
	});

	test("returns descriptive reason when fetch throws", async () => {
		const pubPath = path.join(tmpDir, "throw.pub");
		await fs.writeFile(pubPath, GLOBAL_KEY.pubText);
		stubFetch(async () => {
			throw new Error("ETIMEDOUT");
		});
		const { verifyDownloadedUpdate } = await import("./minisign-verify");
		const result = await verifyDownloadedUpdate({
			artifactPath: path.join(tmpDir, "any.exe"),
			pubkeyPath: pubPath,
			sidecarUrl: "https://example.invalid/x.minisig",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/failed to fetch .minisig sidecar/);
		}
	});
});

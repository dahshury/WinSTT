#!/usr/bin/env node
/**
 * Bring the dedicated CDP capture Chrome on-screen and open the unique app
 * sessions that need a one-time login. The user signs in (password + 2FA); the
 * profile (artifacts/chrome-cdp-profile) persists so this is one-time.
 */
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WS = require("ws");
const PORT = process.env.CDP_PORT ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGINS = [
	["Google / Gmail", "https://accounts.google.com/ServiceLogin?continue=https://mail.google.com/mail/u/0/"],
	["Discord", "https://discord.com/login"],
	["X (Twitter)", "https://x.com/i/flow/login"],
	["Facebook / Messenger", "https://www.facebook.com/login/"],
	["WhatsApp (scan QR with phone)", "https://web.whatsapp.com/"],
];

function getJSON(p) {
	return new Promise((res, rej) => {
		http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
			let d = "";
			r.on("data", (c) => (d += c));
			r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
		}).on("error", rej);
	});
}

async function main() {
	const v = await getJSON("/json/version");
	const ws = new WS(v.webSocketDebuggerUrl, { maxPayload: 1e8 });
	await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
	let id = 0; const pend = new Map(); const ls = [];
	ws.on("message", (raw) => {
		const m = JSON.parse(raw);
		if (m.id && pend.has(m.id)) { const { r } = pend.get(m.id); pend.delete(m.id); r(m.result); }
		else if (m.method) { for (const l of ls) l(m); }
	});
	const send = (method, params = {}, s) => {
		const i = ++id; const msg = { id: i, method, params }; if (s) msg.sessionId = s;
		ws.send(JSON.stringify(msg)); return new Promise((r) => pend.set(i, { r }));
	};
	const waitAttach = (t) => new Promise((r) => {
		const cb = (m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.targetId === t) { ls.splice(ls.indexOf(cb), 1); r(m.params.sessionId); } };
		ls.push(cb);
	});

	await send("Target.setDiscoverTargets", { discover: true });

	// Open the first login in a fresh window we can position on-screen.
	const first = await send("Target.createTarget", { url: LOGINS[0][1], newWindow: true });
	const firstTarget = first.targetId;
	// Position + maximize the window.
	const win = await send("Browser.getWindowForTarget", { targetId: firstTarget });
	const windowId = win.windowId;
	await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", left: 40, top: 40, width: 1500, height: 950 } });
	await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
	// bringToFront on the page so it renders + raises.
	const ap = waitAttach(firstTarget);
	await send("Target.attachToTarget", { targetId: firstTarget, flatten: true });
	const s = await ap;
	await send("Page.enable", {}, s).catch(() => {});
	await send("Page.bringToFront", {}, s).catch(() => {});

	// Open the remaining logins as tabs in the same window.
	for (let i = 1; i < LOGINS.length; i++) {
		await send("Target.createTarget", { url: LOGINS[i][1], newWindow: false });
		await sleep(300);
	}

	console.log("Capture browser is on-screen with these login tabs:");
	for (const [name, url] of LOGINS) console.log("  - " + name + "  (" + url + ")");
	console.log("\nWindowId:", windowId);
	ws.close();
}

main().catch((e) => { console.error("show-login failed:", e.message); process.exit(1); });

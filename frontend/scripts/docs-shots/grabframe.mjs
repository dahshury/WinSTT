// Extract a mid-clip frame from each demo .webm for visual verification.

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const DIR = resolve("../docs/public/demos");
const files = readdirSync(DIR).filter((f) => f.endsWith(".webm"));
const b = await chromium.launch();
const p = await (
	await b.newContext({ viewport: { width: 760, height: 320 }, deviceScaleFactor: 2 })
).newPage();
for (const f of files) {
	const url = `file:///${resolve(DIR, f).replace(/\\/g, "/")}`;
	await p.setContent(
		`<body style="margin:0;background:#0a0a0f"><video id=v src="${url}" muted autoplay playsinline style="display:block"></video></body>`
	);
	await p.evaluate(() =>
		document
			.getElementById("v")
			.play()
			.catch(() => {})
	);
	await p.waitForTimeout(3000); // let it play to a representative frame
	await p.locator("#v").screenshot({ path: resolve(DIR, `_frame-${f.replace(".webm", ".png")}`) });
	console.log("frame", f);
}
await b.close();

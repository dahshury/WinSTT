// electron-builder `afterPack` hook.
//
// Runs after electron-builder copies the app + resources into the packaged
// output but before it signs/zips the final artifact. Today the only job
// here is pruning the Chromium .pak locale files we don't ship.
const path = require("node:path");
const { existsSync, readdirSync, statSync, unlinkSync } = require("node:fs");

// Chromium ships ~55 locale .pak files (~30 MB total). We only support
// these UI languages — see frontend/messages/*.json. Dropping the rest
// is invisible to the user and shaves ~30 MB off the unpacked tree
// (~10 MB off the compressed portable .exe).
const KEEP_LOCALES = new Set([
	"en-US.pak",
	"en-GB.pak",
	"ar.pak",
	"es.pak",
	"es-419.pak",
	"fr.pak",
	"hi.pak",
	"zh-CN.pak",
	"zh-TW.pak",
]);

function pruneChromiumLocales(appOutDir) {
	const localesDir = path.join(appOutDir, "locales");
	if (!existsSync(localesDir)) {
		return;
	}
	let removed = 0;
	let removedBytes = 0;
	for (const file of readdirSync(localesDir)) {
		if (!file.endsWith(".pak") || KEEP_LOCALES.has(file)) {
			continue;
		}
		const full = path.join(localesDir, file);
		removedBytes += statSync(full).size;
		unlinkSync(full);
		removed += 1;
	}
	console.log(
		`[afterPack] pruned ${removed} unused Chromium locale .pak files ` +
			`(~${(removedBytes / 1024 / 1024).toFixed(1)} MB)`
	);
}

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
	pruneChromiumLocales(context.appOutDir);
};

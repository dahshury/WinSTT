#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_MAX_JS_FILES = 9; // The report requires strictly fewer than 10.
const DEFAULT_MAX_JS_BYTES = 1024 * 1024 - 1; // Strictly below 1 MiB.
const DEFAULT_MAX_INITIAL_BYTES = 1.25 * 1024 * 1024;

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer; received ${value}`);
	}
	return parsed;
}

function htmlAssetReferences(html, tag, attribute, predicate) {
	const references = [];
	const tagExpression = new RegExp(`<${tag}\\b[^>]*>`, "gi");
	for (const tagMatch of html.matchAll(tagExpression)) {
		const source = tagMatch[0];
		const attributeMatch = source.match(
			new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"),
		);
		if (attributeMatch?.[1] && predicate(source, attributeMatch[1])) {
			references.push(attributeMatch[1]);
		}
	}
	return references;
}

function normalizeAssetReference(reference) {
	const withoutQuery = reference.split(/[?#]/, 1)[0];
	return decodeURIComponent(withoutQuery.replace(/^\.\//, ""));
}

async function assetBytes(distDir, reference) {
	const relative = normalizeAssetReference(reference);
	const absolute = path.resolve(distDir, relative);
	const root = `${path.resolve(distDir)}${path.sep}`;
	if (!absolute.startsWith(root)) {
		throw new Error(`Startup asset escapes dist/: ${reference}`);
	}
	return (await stat(absolute)).size;
}

function manifestStaticFiles(manifest, entryKey) {
	const visited = new Set();
	function visit(key) {
		if (visited.has(key)) return;
		const chunk = manifest[key];
		if (!chunk) throw new Error(`Manifest import is missing: ${key}`);
		visited.add(key);
		for (const dependency of chunk.imports ?? []) visit(dependency);
	}
	visit(entryKey);
	return new Set([...visited].map((key) => manifest[key].file));
}

function formatBytes(bytes) {
	return `${bytes.toLocaleString("en-US")} B (${(bytes / 1024).toFixed(1)} KiB)`;
}

async function main() {
	const distDir = path.resolve(option("--dist", "dist"));
	const htmlRelative = option("--html", "index.html");
	const maxJsFiles = positiveInteger(
		option("--max-js-files", String(DEFAULT_MAX_JS_FILES)),
		"--max-js-files",
	);
	const maxJsBytes = positiveInteger(
		option("--max-js-bytes", String(DEFAULT_MAX_JS_BYTES)),
		"--max-js-bytes",
	);
	const maxInitialBytes = positiveInteger(
		option("--max-initial-bytes", String(DEFAULT_MAX_INITIAL_BYTES)),
		"--max-initial-bytes",
	);

	const htmlPath = path.resolve(distDir, htmlRelative);
	const html = await readFile(htmlPath, "utf8");
	const manifest = JSON.parse(
		await readFile(path.join(distDir, ".vite", "manifest.json"), "utf8"),
	);
	const manifestEntry = manifest[htmlRelative.replaceAll("\\", "/")];
	if (!manifestEntry?.isEntry) {
		throw new Error(`No Vite manifest entry for ${htmlRelative}`);
	}

	const entryScripts = htmlAssetReferences(
		html,
		"script",
		"src",
		(source, reference) =>
			/\btype=["']module["']/i.test(source) &&
			/\.js(?:[?#]|$)/i.test(reference),
	);
	const preloads = htmlAssetReferences(
		html,
		"link",
		"href",
		(source, reference) =>
			/\brel=["']modulepreload["']/i.test(source) &&
			/\.js(?:[?#]|$)/i.test(reference),
	);
	const stylesheets = htmlAssetReferences(html, "link", "href", (source) =>
		/\brel=["']stylesheet["']/i.test(source),
	);
	const jsAssets = [...new Set([...entryScripts, ...preloads])];
	const cssAssets = [...new Set(stylesheets)];
	if (entryScripts.length !== 1) {
		throw new Error(
			`${htmlRelative} must contain exactly one module entry script; found ${entryScripts.length}`,
		);
	}

	const manifestFiles = manifestStaticFiles(
		manifest,
		htmlRelative.replaceAll("\\", "/"),
	);
	if (!manifestFiles.has(normalizeAssetReference(entryScripts[0]))) {
		throw new Error("HTML module entry does not match the Vite manifest entry");
	}
	for (const reference of jsAssets) {
		if (!manifestFiles.has(normalizeAssetReference(reference))) {
			throw new Error(
				`HTML schedules JS outside its static manifest graph: ${reference}`,
			);
		}
	}

	const jsBytes = (
		await Promise.all(jsAssets.map((asset) => assetBytes(distDir, asset)))
	).reduce((total, bytes) => total + bytes, 0);
	const cssBytes = (
		await Promise.all(cssAssets.map((asset) => assetBytes(distDir, asset)))
	).reduce((total, bytes) => total + bytes, 0);
	const initialBytes = jsBytes + cssBytes;

	console.log(
		`Main startup: ${jsAssets.length} HTML-scheduled JS files, ${formatBytes(jsBytes)} raw JS; ` +
			`${cssAssets.length} CSS files, ${formatBytes(cssBytes)}; ${formatBytes(initialBytes)} combined.`,
	);
	console.log(
		`Budgets: <10 JS files, <1 MiB raw HTML-scheduled JS, <=1.25 MiB combined JS+CSS. ` +
			`Manifest static imports are used to verify graph membership; lazy imports are excluded.`,
	);

	const failures = [];
	if (jsAssets.length > maxJsFiles) {
		failures.push(
			`${jsAssets.length} JS files exceeds the ${maxJsFiles}-file maximum`,
		);
	}
	if (jsBytes > maxJsBytes) {
		failures.push(
			`${formatBytes(jsBytes)} JS exceeds ${formatBytes(maxJsBytes)}`,
		);
	}
	if (initialBytes > maxInitialBytes) {
		failures.push(
			`${formatBytes(initialBytes)} combined JS+CSS exceeds ${formatBytes(maxInitialBytes)}`,
		);
	}
	if (failures.length > 0) {
		throw new Error(
			`Startup bundle budget failed:\n- ${failures.join("\n- ")}`,
		);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

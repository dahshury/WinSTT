#!/usr/bin/env node
// Regenerates the download-badge block in README.md so the direct one-click
// download links always point at the current release tag.
//
// Every WinSTT release is a prerelease, so GitHub's `/releases/latest` URLs 404
// and cannot be used. Direct-download links must therefore reference the exact
// tag, and the macOS/Linux asset filenames embed the version. This script keeps
// all of that in sync with package.json.
//
//   node tools/release/sync-readme-download-badges.mjs           # rewrite README
//   node tools/release/sync-readme-download-badges.mjs --check   # fail if stale
//
// Run it after bumping the version. The release workflow also runs --check so a
// stale README block fails the release instead of shipping dead links.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const readmePath = join(repoRoot, "README.md");
const packageJsonPath = join(repoRoot, "package.json");

const START = "<!-- DOWNLOAD_BADGES:START -->";
const END = "<!-- DOWNLOAD_BADGES:END -->";

const owner = "dahshury";
const repo = "WinSTT";
const releasesBase = `https://github.com/${owner}/${repo}/releases`;

function assetUrl(tag, asset) {
	return `${releasesBase}/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

// A shields.io "for-the-badge" image URL. Label/message are pre-escaped for the
// badge path grammar (dashes doubled, spaces as underscores).
function badge(message, { logo, logoColor = "white", color, labelColor }) {
	const params = new URLSearchParams({ style: "for-the-badge" });
	if (logo) params.set("logo", logo);
	if (logoColor) params.set("logoColor", logoColor);
	if (labelColor) params.set("labelColor", labelColor);
	const safe = message.replace(/-/g, "--").replace(/ /g, "_");
	return `https://img.shields.io/badge/${safe}-${color}?${params.toString()}`;
}

export function renderBadges(version) {
	const tag = `v${version}`;
	const releasePage = `${releasesBase}/tag/${encodeURIComponent(tag)}`;

	const primary = [
		{
			alt: "Download WinSTT for Windows",
			href: assetUrl(tag, "WinSTT.exe"),
			img: badge("Download-Windows", {
				logo: "windows11",
				color: "0A66C2",
				labelColor: "0A66C2",
			}),
		},
		{
			alt: "Download WinSTT for macOS",
			href: assetUrl(tag, `WinSTT_${version}_aarch64.dmg`),
			img: badge("Download-macOS", {
				logo: "apple",
				color: "111111",
				labelColor: "111111",
			}),
		},
		{
			alt: "Download WinSTT for Linux",
			href: assetUrl(tag, `WinSTT_${version}_amd64.AppImage`),
			img: badge("Download-Linux", {
				logo: "linux",
				logoColor: "black",
				color: "F5B700",
				labelColor: "F5B700",
			}),
		},
	];

	const secondary = [
		["Windows portable (.zip)", assetUrl(tag, "WinSTT-portable.zip")],
		["Debian / Ubuntu (.deb)", assetUrl(tag, `WinSTT_${version}_amd64.deb`)],
		["Fedora / RHEL (.rpm)", assetUrl(tag, `WinSTT-${version}-1.x86_64.rpm`)],
		[`All ${tag} assets`, releasePage],
	];

	const primaryHtml = primary
		.map((b) => `  <a href="${b.href}"><img alt="${b.alt}" src="${b.img}"></a>`)
		.join("\n  &nbsp;\n");

	const secondaryHtml = secondary
		.map(([label, href]) => `<a href="${href}">${label}</a>`)
		.join(" · ");

	return [
		START,
		"",
		'<p align="center">',
		primaryHtml,
		"</p>",
		"",
		'<p align="center">',
		`  <sub>${secondaryHtml}</sub>`,
		"</p>",
		"",
		END,
	].join("\n");
}

function main() {
	const check = process.argv.includes("--check");
	const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const readme = readFileSync(readmePath, "utf8");

	const startIndex = readme.indexOf(START);
	const endIndex = readme.indexOf(END);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		console.error(
			`README.md is missing the ${START} … ${END} markers; cannot sync badges.`,
		);
		process.exit(1);
	}

	const block = renderBadges(version);
	const next =
		readme.slice(0, startIndex) + block + readme.slice(endIndex + END.length);

	if (next === readme) {
		console.log(`README download badges already in sync (v${version}).`);
		return;
	}

	if (check) {
		console.error(
			`README download badges are stale for v${version}. ` +
				"Run: node tools/release/sync-readme-download-badges.mjs",
		);
		process.exit(1);
	}

	writeFileSync(readmePath, next);
	console.log(`Updated README download badges to v${version}.`);
}

main();

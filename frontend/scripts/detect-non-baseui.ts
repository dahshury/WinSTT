/**
 * Detects raw HTML form elements in TSX files that should use BaseUI components.
 *
 * Run:  bun scripts/detect-non-baseui.ts
 *
 * Maps:
 *   <input>     → TextField  (@/shared/ui/text-field)
 *   <select>    → Select     (@/shared/ui/select)
 *   <textarea>  → Textarea   (baseui/textarea)
 *   <button>    → Button     (@/shared/ui/button)
 *   <checkbox>  → Toggle     (@/shared/ui/toggle)
 *   <form>      → (review - may need BaseUI FormControl)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dirname, "..", "src");

const PATTERNS: Array<{ regex: RegExp; element: string; replacement: string }> = [
	{ regex: /<input[\s\n]/g, element: "<input>", replacement: "TextField (@/shared/ui/text-field)" },
	{ regex: /<select[\s\n>]/g, element: "<select>", replacement: "Select (@/shared/ui/select)" },
	{ regex: /<textarea[\s\n>]/g, element: "<textarea>", replacement: "Textarea (baseui/textarea)" },
	{ regex: /<button[\s\n>]/g, element: "<button>", replacement: "Button (@/shared/ui/button)" },
];

interface Violation {
	context: string;
	element: string;
	file: string;
	line: number;
	replacement: string;
}

function walk(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === "node_modules" || entry === ".next" || entry === "dist-electron") {
			continue;
		}
		if (statSync(full).isDirectory()) {
			files.push(...walk(full));
		} else if (full.endsWith(".tsx")) {
			files.push(full);
		}
	}
	return files;
}

const violations: Violation[] = [];

for (const file of walk(SRC_DIR)) {
	const content = readFileSync(file, "utf-8");
	const lines = content.split("\n");

	for (const { regex, element, replacement } of PATTERNS) {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: simple regex scan
		while ((match = regex.exec(content)) !== null) {
			const lineNum = content.slice(0, match.index).split("\n").length;
			const lineText = lines[lineNum - 1]?.trim() ?? "";
			violations.push({
				file: relative(join(SRC_DIR, ".."), file),
				line: lineNum,
				element,
				replacement,
				context: lineText.slice(0, 80),
			});
		}
	}
}

if (violations.length === 0) {
	console.log("All form elements use BaseUI components.");
} else {
	console.log(`Found ${violations.length} non-BaseUI form element(s):\n`);
	for (const v of violations) {
		console.log(`  ${v.file}:${v.line}`);
		console.log(`    ${v.element} → use ${v.replacement}`);
		console.log(`    ${v.context}\n`);
	}
	process.exit(1);
}

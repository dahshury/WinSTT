import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC = join(import.meta.dir, "..", "..");
const NON_INVOKED_FAITHFUL_MOCK = /\.\.\.ipcClientMock\b(?!\s*\()/;

function testFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			files.push(...testFiles(path));
		} else if (/\.test\.(?:ts|tsx)$/.test(entry)) {
			files.push(path);
		}
	}
	return files;
}

describe("ipc-client test mock discipline", () => {
	test("invokes ipcClientMock before spreading the faithful fake", () => {
		const offenders = testFiles(SRC)
			.filter((path) =>
				NON_INVOKED_FAITHFUL_MOCK.test(readFileSync(path, "utf8")),
			)
			.map((path) => relative(SRC, path))
			.sort();

		expect(offenders).toEqual([]);
	});
});

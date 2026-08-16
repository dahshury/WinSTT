import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export default function globalTeardown(): void {
	const candidate = process.env["WINSTT_SETTINGS_E2E_APP_DATA_DIR"];
	if (!candidate) {
		return;
	}

	const resolved = resolve(candidate);
	const expectedParent = resolve(tmpdir());
	const safe =
		resolve(dirname(resolved)) === expectedParent &&
		basename(resolved).startsWith("winstt-settings-e2e-");
	if (!safe) {
		throw new Error(
			`Refusing to remove unexpected E2E data directory: ${resolved}`,
		);
	}

	rmSync(resolved, { force: true, recursive: true });
}

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { electronMock } from "@test/mocks/electron";

const electronBase = electronMock();
mock.module("electron", () => electronBase);

const mod = await import("./renderer-url");
const {
	getDevPageUrl,
	getPackagedPagePath,
	isAllowedRendererUrl,
	isHttpUrl,
	isSameOrigin,
	loadRendererPage,
} = mod;

function setPackaged(value: boolean): void {
	(electronBase.app as unknown as { isPackaged: boolean }).isPackaged = value;
}

const originalResourcesPath = (process as unknown as { resourcesPath: string }).resourcesPath;

beforeAll(() => {
	setPackaged(false);
});

afterAll(() => {
	setPackaged(false);
	(process as unknown as { resourcesPath: string }).resourcesPath = originalResourcesPath;
});

describe("getDevPageUrl", () => {
	test("main page resolves to bare dev origin (no /index.html suffix)", () => {
		expect(getDevPageUrl("main")).toBe("http://localhost:3000/");
	});

	test("non-main page resolves to its filename under the dev origin", () => {
		expect(getDevPageUrl("settings")).toBe("http://localhost:3000/settings.html");
		expect(getDevPageUrl("overlay")).toBe("http://localhost:3000/overlay.html");
		expect(getDevPageUrl("tray-menu")).toBe("http://localhost:3000/tray-menu.html");
		expect(getDevPageUrl("model-picker")).toBe("http://localhost:3000/model-picker.html");
		expect(getDevPageUrl("device-picker")).toBe("http://localhost:3000/device-picker.html");
		expect(getDevPageUrl("onboarding")).toBe("http://localhost:3000/onboarding.html");
	});
});

describe("getPackagedPagePath", () => {
	test("dev mode resolves under dist-renderer next to electron output", () => {
		setPackaged(false);
		const p = getPackagedPagePath("settings");
		expect(p.endsWith(`${path.sep}settings.html`)).toBe(true);
		expect(p.includes("dist-renderer")).toBe(true);
	});

	test("packaged mode resolves under process.resourcesPath/renderer", () => {
		setPackaged(true);
		(process as unknown as { resourcesPath: string }).resourcesPath =
			path.normalize("C:\\fake\\res");
		const p = getPackagedPagePath("main");
		expect(p).toBe(path.join("C:\\fake\\res", "renderer", "index.html"));
		setPackaged(false);
	});
});

describe("loadRendererPage", () => {
	test("dev mode delegates to win.loadURL with the dev URL", async () => {
		setPackaged(false);
		const calls: { kind: string; arg: string }[] = [];
		const fakeWin = {
			loadURL: (u: string) => {
				calls.push({ kind: "url", arg: u });
				return Promise.resolve();
			},
			loadFile: (f: string) => {
				calls.push({ kind: "file", arg: f });
				return Promise.resolve();
			},
		};
		await loadRendererPage(fakeWin as unknown as Parameters<typeof loadRendererPage>[0], "main");
		expect(calls).toEqual([{ kind: "url", arg: "http://localhost:3000/" }]);
	});

	test("packaged mode delegates to win.loadFile with the packaged path", async () => {
		setPackaged(true);
		(process as unknown as { resourcesPath: string }).resourcesPath =
			path.normalize("C:\\fake\\res");
		const calls: { kind: string; arg: string }[] = [];
		const fakeWin = {
			loadURL: (u: string) => {
				calls.push({ kind: "url", arg: u });
				return Promise.resolve();
			},
			loadFile: (f: string) => {
				calls.push({ kind: "file", arg: f });
				return Promise.resolve();
			},
		};
		await loadRendererPage(
			fakeWin as unknown as Parameters<typeof loadRendererPage>[0],
			"settings"
		);
		expect(calls).toEqual([
			{ kind: "file", arg: path.join("C:\\fake\\res", "renderer", "settings.html") },
		]);
		setPackaged(false);
	});
});

describe("isAllowedRendererUrl", () => {
	test("returns false for unparseable URLs", () => {
		expect(isAllowedRendererUrl("not a url")).toBe(false);
		expect(isAllowedRendererUrl("")).toBe(false);
	});

	test("dev mode accepts the dev origin", () => {
		setPackaged(false);
		expect(isAllowedRendererUrl("http://localhost:3000/")).toBe(true);
		expect(isAllowedRendererUrl("http://localhost:3000/settings.html")).toBe(true);
	});

	test("dev mode rejects other origins", () => {
		setPackaged(false);
		expect(isAllowedRendererUrl("http://example.com/")).toBe(false);
		expect(isAllowedRendererUrl("https://localhost:3000/")).toBe(false);
	});

	test("packaged mode rejects non-file: protocols", () => {
		setPackaged(true);
		(process as unknown as { resourcesPath: string }).resourcesPath =
			path.normalize("C:\\fake\\res");
		expect(isAllowedRendererUrl("https://example.com/")).toBe(false);
		expect(isAllowedRendererUrl("http://localhost:3000/")).toBe(false);
		setPackaged(false);
	});

	test("packaged mode accepts file: URLs inside renderer root", () => {
		setPackaged(true);
		(process as unknown as { resourcesPath: string }).resourcesPath =
			path.normalize("C:\\fake\\res");
		expect(isAllowedRendererUrl("file:///C:/fake/res/renderer/index.html")).toBe(true);
		expect(isAllowedRendererUrl("file:///C:/fake/res/renderer/sub/page.html")).toBe(true);
		setPackaged(false);
	});

	test("packaged mode rejects file: URLs outside the renderer root", () => {
		setPackaged(true);
		(process as unknown as { resourcesPath: string }).resourcesPath =
			path.normalize("C:\\fake\\res");
		expect(isAllowedRendererUrl("file:///C:/Windows/System32/cmd.exe")).toBe(false);
		expect(isAllowedRendererUrl("file:///C:/fake/other/page.html")).toBe(false);
		setPackaged(false);
	});
});

describe("isSameOrigin", () => {
	test("true for identical origins", () => {
		expect(isSameOrigin("https://example.com/a", "https://example.com/b")).toBe(true);
	});

	test("false for differing origins", () => {
		expect(isSameOrigin("https://example.com/", "https://other.com/")).toBe(false);
		expect(isSameOrigin("http://example.com/", "https://example.com/")).toBe(false);
	});

	test("false when either side is unparseable", () => {
		expect(isSameOrigin("not a url", "https://example.com/")).toBe(false);
		expect(isSameOrigin("https://example.com/", "")).toBe(false);
	});
});

describe("isHttpUrl", () => {
	test("recognises http and https schemes", () => {
		expect(isHttpUrl("http://example.com/")).toBe(true);
		expect(isHttpUrl("https://example.com/")).toBe(true);
	});

	test("rejects other schemes and bare strings", () => {
		expect(isHttpUrl("file:///foo")).toBe(false);
		expect(isHttpUrl("ftp://example.com/")).toBe(false);
		expect(isHttpUrl("example.com")).toBe(false);
		expect(isHttpUrl("")).toBe(false);
	});
});

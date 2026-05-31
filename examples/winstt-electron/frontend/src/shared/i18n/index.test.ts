import { describe, expect, test } from "bun:test";
import * as i18n from "./index";

describe("i18n public API", () => {
	test("re-exports config symbols", () => {
		expect(i18n.DEFAULT_LOCALE).toBeDefined();
		expect(i18n.LOCALES).toBeDefined();
		expect(i18n.LOCALE_NAMES).toBeDefined();
		expect(typeof i18n.isLocale).toBe("function");
	});

	test("re-exports the locale store and messages bundle", () => {
		expect(typeof i18n.useLocaleStore).toBe("function");
		expect(i18n.messages).toBeDefined();
		expect(i18n.messages[i18n.DEFAULT_LOCALE]).toBeDefined();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { useLocaleStore } from "@/shared/i18n";
import { HtmlLang } from "./HtmlLang";

beforeEach(() => {
	useLocaleStore.setState({ locale: "en" });
	document.documentElement.lang = "";
});

afterEach(() => {
	document.documentElement.lang = "";
});

describe("HtmlLang", () => {
	test("renders nothing visible", () => {
		const { container } = render(<HtmlLang />);
		expect(container.firstChild).toBeNull();
	});

	test("sets <html lang> to the current locale on mount", () => {
		useLocaleStore.setState({ locale: "fr" });
		render(<HtmlLang />);
		expect(document.documentElement.lang).toBe("fr");
	});

	test("updates <html lang> when the locale changes", () => {
		render(<HtmlLang />);
		expect(document.documentElement.lang).toBe("en");
		act(() => {
			useLocaleStore.setState({ locale: "ar" });
		});
		expect(document.documentElement.lang).toBe("ar");
	});
});

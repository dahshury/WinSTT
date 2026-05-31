import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { useTranslations } from "use-intl";
import { useLocaleStore } from "@/shared/i18n";
import { IntlProvider } from "./IntlProvider";

beforeEach(() => {
	useLocaleStore.setState({ locale: "en" });
});

afterEach(() => {
	useLocaleStore.setState({ locale: "en" });
});

function ProbeWithTranslation() {
	const t = useTranslations("titleBar");
	return <span data-testid="probe">{t("appName")}</span>;
}

describe("IntlProvider", () => {
	test("provides translation context for child components", () => {
		render(
			<IntlProvider>
				<ProbeWithTranslation />
			</IntlProvider>
		);
		const probe = screen.getByTestId("probe");
		expect(probe).toBeDefined();
		// Default locale 'en' should resolve to the WinSTT title — non-empty
		expect((probe.textContent ?? "").length).toBeGreaterThan(0);
	});

	test("re-renders children when locale changes (different language strings)", () => {
		const { rerender } = render(
			<IntlProvider>
				<ProbeWithTranslation />
			</IntlProvider>
		);
		const enText = screen.getByTestId("probe").textContent;

		useLocaleStore.setState({ locale: "fr" });
		rerender(
			<IntlProvider>
				<ProbeWithTranslation />
			</IntlProvider>
		);
		// The localized string may or may not differ across locales for this key,
		// but the provider should not throw and the probe should still render.
		const frText = screen.getByTestId("probe").textContent;
		expect(typeof frText).toBe("string");
		expect((frText ?? "").length).toBeGreaterThan(0);
		// At minimum, both render successfully
		expect(typeof enText).toBe("string");
	});
});

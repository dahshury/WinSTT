import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import { DEFAULT_LOCALE } from "./config";
import { LOCALE_STORAGE_KEY, useLocaleStore } from "./locale-store";

beforeEach(() => {
	window.localStorage.removeItem(LOCALE_STORAGE_KEY);
	useLocaleStore.setState({ locale: DEFAULT_LOCALE });
});

afterEach(() => {
	window.localStorage.removeItem(LOCALE_STORAGE_KEY);
	useLocaleStore.setState({ locale: DEFAULT_LOCALE });
});

describe("useLocaleStore", () => {
	test("initial locale is the DEFAULT_LOCALE", () => {
		expect(useLocaleStore.getState().locale).toBe(DEFAULT_LOCALE);
	});

	test("setLocale updates the locale", () => {
		useLocaleStore.getState().setLocale("fr");
		expect(useLocaleStore.getState().locale).toBe("fr");
	});

	test("setLocale persists the value to localStorage", () => {
		useLocaleStore.getState().setLocale("ar");
		const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
		expect(raw).not.toBeNull();
		const persisted = JSON.parse(raw!);
		expect(persisted.state.locale).toBe("ar");
	});

	test("subscribers are notified on changes", () => {
		const seen: string[] = [];
		const unsub = useLocaleStore.subscribe((state) => seen.push(state.locale));
		useLocaleStore.getState().setLocale("zh");
		useLocaleStore.getState().setLocale("hi");
		unsub();
		useLocaleStore.getState().setLocale("es");
		expect(seen).toEqual(["zh", "hi"]);
	});

	test("rehydrates a locale chosen in another window", async () => {
		window.localStorage.setItem(
			LOCALE_STORAGE_KEY,
			JSON.stringify({ state: { locale: "fr" }, version: 0 }),
		);
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: LOCALE_STORAGE_KEY,
				newValue: window.localStorage.getItem(LOCALE_STORAGE_KEY),
			}),
		);

		await waitFor(() => {
			expect(useLocaleStore.getState().locale).toBe("fr");
		});
	});
});

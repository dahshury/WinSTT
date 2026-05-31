import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE } from "./config";
import { useLocaleStore } from "./locale-store";

const PERSIST_KEY = "winstt-locale";

beforeEach(() => {
	window.localStorage.removeItem(PERSIST_KEY);
	useLocaleStore.setState({ locale: DEFAULT_LOCALE });
});

afterEach(() => {
	window.localStorage.removeItem(PERSIST_KEY);
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
		const raw = window.localStorage.getItem(PERSIST_KEY);
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
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
	__use_favorite_providers_test_helpers__ as helpers,
	useFavoriteProviders,
} from "./use-favorite-providers";

const STORAGE_KEY = "winstt:openrouter-favorite-providers";

beforeEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

describe("parseStoredFavorites", () => {
	test("returns null for null input", () => {
		expect(helpers.parseStoredFavorites(null)).toBeNull();
	});

	test("returns null for empty string input", () => {
		expect(helpers.parseStoredFavorites("")).toBeNull();
	});

	test("returns parsed array when valid non-empty JSON array", () => {
		expect(helpers.parseStoredFavorites('["openai","google"]')).toEqual(["openai", "google"]);
	});

	test("returns null when JSON is an empty array", () => {
		expect(helpers.parseStoredFavorites("[]")).toBeNull();
	});

	test("throws for invalid JSON (let caller catch)", () => {
		expect(() => helpers.parseStoredFavorites("{not-json")).toThrow();
	});

	test("returns null when parsed value is not an array", () => {
		expect(helpers.parseStoredFavorites('"just a string"')).toBeNull();
	});
});

describe("readStoredFavorites", () => {
	const STORAGE_KEY = "winstt:openrouter-favorite-providers";

	beforeEach(() => {
		window.localStorage.removeItem(STORAGE_KEY);
	});

	afterEach(() => {
		window.localStorage.removeItem(STORAGE_KEY);
	});

	test("returns null when localStorage has no value", () => {
		expect(helpers.readStoredFavorites()).toBeNull();
	});

	test("returns the stored favorites when present", () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["openai"]));
		expect(helpers.readStoredFavorites()).toEqual(["openai"]);
	});

	test("returns null when stored value is malformed JSON", () => {
		window.localStorage.setItem(STORAGE_KEY, "{not-json");
		expect(helpers.readStoredFavorites()).toBeNull();
	});

	test("returns null when stored array is empty", () => {
		window.localStorage.setItem(STORAGE_KEY, "[]");
		expect(helpers.readStoredFavorites()).toBeNull();
	});
});

describe("useFavoriteProviders", () => {
	test("returns the canonical default favorites when nothing is stored", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		expect(result.current.favorites).toEqual(["openai", "google", "anthropic"]);
	});

	test("loads stored favorites if present", () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["xai"]));
		const { result } = renderHook(() => useFavoriteProviders());
		expect(result.current.favorites).toEqual(["xai"]);
	});

	test("isFavorite reflects current state", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		expect(result.current.isFavorite("openai")).toBe(true);
		expect(result.current.isFavorite("xai")).toBe(false);
	});

	test("addFavorite appends a unique provider", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		act(() => result.current.addFavorite("xai"));
		expect(result.current.favorites).toContain("xai");
	});

	test("addFavorite is a no-op when provider is already favorited", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		const before = result.current.favorites.length;
		act(() => result.current.addFavorite("openai"));
		expect(result.current.favorites.length).toBe(before);
	});

	test("removeFavorite drops the provider", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		act(() => result.current.removeFavorite("openai"));
		expect(result.current.favorites).not.toContain("openai");
	});

	test("toggleFavorite adds-then-removes round-trip", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		act(() => result.current.toggleFavorite("xai"));
		expect(result.current.isFavorite("xai")).toBe(true);
		act(() => result.current.toggleFavorite("xai"));
		expect(result.current.isFavorite("xai")).toBe(false);
	});

	test("persists favorites to localStorage on change", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		act(() => result.current.addFavorite("xai"));
		const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
		expect(persisted).toContain("xai");
	});

	test("falls back to defaults when stored value is malformed", () => {
		window.localStorage.setItem(STORAGE_KEY, "{not-json");
		const { result } = renderHook(() => useFavoriteProviders());
		expect(result.current.favorites).toEqual(["openai", "google", "anthropic"]);
	});

	test("falls back to defaults when stored array is empty", () => {
		window.localStorage.setItem(STORAGE_KEY, "[]");
		const { result } = renderHook(() => useFavoriteProviders());
		expect(result.current.favorites).toEqual(["openai", "google", "anthropic"]);
	});

	test("isLoaded is true (synchronous initialization)", () => {
		const { result } = renderHook(() => useFavoriteProviders());
		expect(result.current.isLoaded).toBe(true);
	});
});

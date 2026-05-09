import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useFavoriteProviders } from "./use-favorite-providers";

const STORAGE_KEY = "winstt:openrouter-favorite-providers";

beforeEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
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

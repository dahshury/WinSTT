import { beforeEach, describe, expect, test } from "bun:test";
// Capture the factory's initial state at module-load time, BEFORE any test
// runs setState(). The store is created at import time so this snapshot
// reflects the literal defaults in the source.
import { useSettingsTabStore } from "./settings-tab-store";

const INITIAL_STATE = useSettingsTabStore.getInitialState();

beforeEach(() => {
	useSettingsTabStore.setState({ activeTab: "general" });
});

describe("useSettingsTabStore", () => {
	test("initial state defaults to the 'general' tab", () => {
		expect(useSettingsTabStore.getState().activeTab).toBe("general");
	});

	test("factory initial-state literal is 'general' (mutation guard)", () => {
		// Reads the snapshot captured before any setState. Mutating the literal
		// in the source ("general" → "") would slip past the beforeEach reset,
		// so we assert the real default here. The settings sidebar opens on the
		// General tab; any other default would land users on the wrong panel.
		expect(INITIAL_STATE.activeTab).toBe("general");
	});

	test("setActiveTab replaces the activeTab field", () => {
		useSettingsTabStore.getState().setActiveTab("models");
		expect(useSettingsTabStore.getState().activeTab).toBe("models");
	});

	test("setActiveTab accepts arbitrary free-form keys (not a closed union)", () => {
		// The store intentionally keeps activeTab a free-form string so adding a
		// tab in SettingsPage doesn't require widening a union here.
		useSettingsTabStore.getState().setActiveTab("a-brand-new-tab");
		expect(useSettingsTabStore.getState().activeTab).toBe("a-brand-new-tab");
	});

	test("setActiveTab overwrites a previously set tab", () => {
		useSettingsTabStore.getState().setActiveTab("cloud");
		useSettingsTabStore.getState().setActiveTab("advanced");
		expect(useSettingsTabStore.getState().activeTab).toBe("advanced");
	});
});

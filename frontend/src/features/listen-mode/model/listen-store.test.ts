import { beforeEach, describe, expect, test } from "bun:test";
import { useListenStore } from "./listen-store";

beforeEach(() => {
	useListenStore.setState({ isListening: false, deviceName: "", devices: [] });
});

describe("useListenStore", () => {
	test("initial state defaults", () => {
		const state = useListenStore.getState();
		expect(state.isListening).toBe(false);
		expect(state.deviceName).toBe("");
		expect(state.devices).toEqual([]);
	});

	test("createStore literal defaults are pinned (immune to other tests' setState)", () => {
		// Targets BooleanLiteral, StringLiteral, and ArrayDeclaration mutations
		// on the create() initial-state object: isListening=false, deviceName="",
		// devices=[]. Without getInitialState() these would be observed only
		// via the live state which other tests freely mutate.
		const initial = useListenStore.getInitialState();
		expect(initial.isListening).toBe(false);
		expect(initial.deviceName).toBe("");
		expect(initial.devices).toEqual([]);
	});

	test("setListening(true, deviceName) sets both", () => {
		useListenStore.getState().setListening(true, "Speakers");
		const state = useListenStore.getState();
		expect(state.isListening).toBe(true);
		expect(state.deviceName).toBe("Speakers");
	});

	test("setListening(true) without deviceName defaults deviceName to empty string", () => {
		useListenStore.getState().setListening(true);
		const state = useListenStore.getState();
		expect(state.isListening).toBe(true);
		expect(state.deviceName).toBe("");
	});

	test("setListening(false) clears both flags regardless of supplied deviceName", () => {
		useListenStore.getState().setListening(true, "Speakers");
		useListenStore.getState().setListening(false, "ignored");
		const state = useListenStore.getState();
		expect(state.isListening).toBe(false);
		expect(state.deviceName).toBe("");
	});

	test("setDevices replaces device list", () => {
		const devices = [
			{ index: 0, name: "Speakers", defaultSampleRate: 48_000, maxOutputChannels: 2 },
		];
		useListenStore.getState().setDevices(devices);
		expect(useListenStore.getState().devices).toEqual(devices);
	});
});

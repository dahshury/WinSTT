import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { commands, type PermissionPreflightStatus } from "@/bindings";
import { usePermissionPreflight } from "./use-permission-preflight";

type PermissionCommandResult = Awaited<
	ReturnType<typeof commands.permissionRunPreflight>
>;

const BLOCKED_STATUS: PermissionPreflightStatus = {
	accessibility: "not_required",
	microphone: "required",
	platform: "windows",
	ready: false,
};

const READY_STATUS: PermissionPreflightStatus = {
	accessibility: "not_required",
	microphone: "granted",
	platform: "windows",
	ready: true,
};

const originalRunPreflight = commands.permissionRunPreflight;
const originalRequestMicrophone = commands.permissionRequestMicrophone;
const originalRequestAccessibility = commands.permissionRequestAccessibility;
const unmounts: Array<() => void> = [];

afterEach(() => {
	for (const unmount of unmounts.splice(0)) {
		act(unmount);
	}
	commands.permissionRunPreflight = originalRunPreflight;
	commands.permissionRequestMicrophone = originalRequestMicrophone;
	commands.permissionRequestAccessibility = originalRequestAccessibility;
});

function successfulResult(
	status: PermissionPreflightStatus,
): PermissionCommandResult {
	return { data: status, status: "ok" };
}

function deferred<T>() {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			if (!resolvePromise) {
				throw new Error("Deferred promise was not initialized");
			}
			resolvePromise(value);
		},
	};
}

function renderPermissionPreflight() {
	const handle = renderHook(() => usePermissionPreflight());
	unmounts.push(handle.unmount);
	return handle;
}

describe("usePermissionPreflight", () => {
	test("settles the initial native preflight asynchronously", async () => {
		commands.permissionRunPreflight = async () =>
			successfulResult(BLOCKED_STATUS);

		const { result } = renderPermissionPreflight();

		expect(result.current.busy).toBe(true);
		await waitFor(() => {
			expect(result.current.busy).toBe(false);
			expect(result.current.error).toBeNull();
			expect(result.current.status).toEqual(BLOCKED_STATUS);
		});
	});

	test("clears busy state and exposes a permission request failure", async () => {
		commands.permissionRunPreflight = async () =>
			successfulResult(BLOCKED_STATUS);
		commands.permissionRequestMicrophone = async () => ({
			error: "microphone request failed",
			status: "error",
		});

		const { result } = renderPermissionPreflight();
		await waitFor(() => {
			expect(result.current.busy).toBe(false);
		});

		act(() => {
			result.current.request("microphone");
		});
		expect(result.current.busy).toBe(true);
		expect(result.current.error).toBeNull();

		await waitFor(() => {
			expect(result.current.busy).toBe(false);
			expect(result.current.error).toBe("microphone request failed");
			expect(result.current.status).toEqual(BLOCKED_STATUS);
		});
	});

	test("ignores an older preflight result after a newer grant succeeds", async () => {
		const preflight = deferred<PermissionCommandResult>();
		commands.permissionRunPreflight = () => preflight.promise;
		commands.permissionRequestMicrophone = async () =>
			successfulResult(READY_STATUS);

		const { result } = renderPermissionPreflight();
		act(() => {
			result.current.request("microphone");
		});

		await waitFor(() => {
			expect(result.current.status).toEqual(READY_STATUS);
			expect(result.current.busy).toBe(false);
		});

		await act(async () => {
			preflight.resolve(successfulResult(BLOCKED_STATUS));
			await preflight.promise;
		});
		expect(result.current.status).toEqual(READY_STATUS);
		expect(result.current.error).toBeNull();
	});
});

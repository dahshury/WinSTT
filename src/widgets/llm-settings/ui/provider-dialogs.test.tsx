import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import type { TranslateFn } from "./types";

interface Deferred<T> {
	promise: Promise<T>;
	reject: (reason?: unknown) => void;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

let startRequest = deferred<{ started: boolean; error?: string }>();
const startOllamaMock = mock(() => startRequest.promise);

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	detectOllama: async () => ({ installed: true }),
	startOllama: startOllamaMock,
}));

const { OllamaDialog } = await import("./provider-dialogs");

const translate = ((key: string) => key) as TranslateFn;

function renderDialog(onStarted = mock(() => undefined)) {
	const onClose = mock(() => undefined);
	const view = render(
		<OllamaDialog
			isOpen={true}
			onClose={onClose}
			onStarted={onStarted}
			t={translate}
			tc={translate}
		/>,
	);
	return { ...view, onClose, onStarted };
}

async function finishDetection(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

async function beginStart(): Promise<void> {
	await finishDetection();
	fireEvent.click(screen.getByRole("button", { name: "runOllama" }));
	expect(startOllamaMock).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
	startRequest = deferred();
	startOllamaMock.mockClear();
});

afterEach(() => {
	cleanup();
});

describe("OllamaDialog start completion", () => {
	test("calls onStarted as soon as the start command reports success", async () => {
		const { onStarted } = renderDialog();
		await beginStart();
		expect(onStarted).not.toHaveBeenCalled();

		await act(async () => {
			startRequest.resolve({ started: true });
			await startRequest.promise;
		});

		expect(onStarted).toHaveBeenCalledTimes(1);
	});

	test("ignores a successful completion after the dialog is closed and reopened", async () => {
		const { onStarted, rerender } = renderDialog();
		await beginStart();

		rerender(
			<OllamaDialog
				isOpen={false}
				onClose={() => undefined}
				onStarted={onStarted}
				t={translate}
				tc={translate}
			/>,
		);
		rerender(
			<OllamaDialog
				isOpen={true}
				onClose={() => undefined}
				onStarted={onStarted}
				t={translate}
				tc={translate}
			/>,
		);

		await act(async () => {
			startRequest.resolve({ started: true });
			await startRequest.promise;
		});

		expect(onStarted).not.toHaveBeenCalled();
	});

	test("ignores a successful completion after unmount", async () => {
		const { onStarted, unmount } = renderDialog();
		await beginStart();
		unmount();

		await act(async () => {
			startRequest.resolve({ started: true });
			await startRequest.promise;
		});

		expect(onStarted).not.toHaveBeenCalled();
	});

	test("keeps command-reported failures visible", async () => {
		const { onStarted } = renderDialog();
		await beginStart();

		await act(async () => {
			startRequest.resolve({ started: false, error: "could not launch" });
			await startRequest.promise;
		});

		expect(screen.getByText("could not launch")).toBeTruthy();
		expect(onStarted).not.toHaveBeenCalled();
	});

	test("keeps rejected-command errors visible", async () => {
		const { onStarted } = renderDialog();
		await beginStart();

		await act(async () => {
			startRequest.reject(new Error("launch rejected"));
			try {
				await startRequest.promise;
			} catch {
				// The component translates this expected rejection into dialog state.
			}
		});

		expect(screen.getByText("launch rejected")).toBeTruthy();
		expect(onStarted).not.toHaveBeenCalled();
	});
});

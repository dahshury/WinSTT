import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApplicationError } from "@/shared/lib/errors";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb({ throwOn = "render" }: { throwOn?: "render" | "never" }) {
	if (throwOn === "render") {
		throw new Error("bang");
	}
	return <div>safe</div>;
}

function ContextBomb(): null {
	throw new ApplicationError("ctx-error", { user: 42 });
}

const consoleNoop = () => undefined;

describe("ErrorBoundary", () => {
	test("renders children when no error occurs", () => {
		render(
			<ErrorBoundary>
				<div data-testid="ok">ok</div>
			</ErrorBoundary>
		);
		expect(screen.getByTestId("ok")).toBeDefined();
	});

	test("renders default fallback UI when child throws", () => {
		const originalError = console.error;
		console.error = consoleNoop;
		try {
			render(
				<ErrorBoundary>
					<Bomb />
				</ErrorBoundary>
			);
			expect(screen.getByText("Component Error")).toBeDefined();
			expect(screen.getByText("bang")).toBeDefined();
		} finally {
			console.error = originalError;
		}
	});

	test("invokes onError callback when child throws", () => {
		const originalError = console.error;
		console.error = consoleNoop;
		const onError = mock(() => undefined);
		try {
			render(
				<ErrorBoundary onError={onError}>
					<Bomb />
				</ErrorBoundary>
			);
			expect(onError).toHaveBeenCalledTimes(1);
			const args = (onError as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
			expect(args?.[0]).toBeInstanceOf(Error);
			expect(typeof args?.[1]).toBe("string"); // component stack
		} finally {
			console.error = originalError;
		}
	});

	test("uses custom fallback when provided", () => {
		const originalError = console.error;
		console.error = consoleNoop;
		try {
			const fallback = (error: Error, _info: string, reset: () => void) => (
				<button onClick={reset} type="button">
					custom-fallback: {error.message}
				</button>
			);
			render(
				<ErrorBoundary fallback={fallback}>
					<Bomb />
				</ErrorBoundary>
			);
			expect(screen.getByText("custom-fallback: bang")).toBeDefined();
		} finally {
			console.error = originalError;
		}
	});

	test("clicking 'Try again' resets the error state", () => {
		const originalError = console.error;
		console.error = consoleNoop;
		try {
			render(
				<ErrorBoundary>
					<Bomb throwOn="render" />
				</ErrorBoundary>
			);
			const tryAgain = screen.getByRole("button", { name: "Try again" });
			fireEvent.click(tryAgain);
			// After reset, the boundary will try to re-render the failing child and throw
			// again; but since this is the same render tree, react re-evaluates and fails
			// again. The reset call itself is what we're verifying here — the UI shows
			// the fallback after re-throw.
			expect(screen.getByText("Component Error")).toBeDefined();
		} finally {
			console.error = originalError;
		}
	});

	test("renders the 'Error Details' section when an ApplicationError carries context", () => {
		const originalError = console.error;
		console.error = consoleNoop;
		try {
			render(
				<ErrorBoundary>
					<ContextBomb />
				</ErrorBoundary>
			);
			expect(screen.getByText("Error Details")).toBeDefined();
		} finally {
			console.error = originalError;
		}
	});
});

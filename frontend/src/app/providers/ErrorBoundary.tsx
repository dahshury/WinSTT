"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { Component, type ReactNode } from "react";
import { formatErrorForLog, isApplicationError } from "@/shared/lib/errors";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: (error: Error, errorInfo: string, reset: () => void) => ReactNode;
	onError?: (error: Error, errorInfo: string) => void;
}

interface ErrorBoundaryState {
	error: Error | null;
	errorInfo: string | null;
	hasError: boolean;
}

/** Renders the collapsible error context details when available. */
function ErrorContextDetails({ error }: { error: Error }): ReactNode {
	if (!(isApplicationError(error) && error.context)) {
		return null;
	}
	return (
		<Collapsible.Root className="mt-2 max-w-[480px] text-body-sm text-foreground-muted">
			<Collapsible.Trigger
				render={
					<Button className="cursor-pointer bg-transparent p-0 font-medium text-foreground-muted hover:text-foreground">
						Error Details
					</Button>
				}
			/>
			<Collapsible.Panel>
				<ScrollArea className="mt-2 max-h-[200px] rounded-sm bg-surface-elevated">
					<pre className="p-3">{JSON.stringify(error.context, null, 2)}</pre>
				</ScrollArea>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

/** Renders the default fallback UI when no custom fallback prop is provided. */
function DefaultFallback({ error, onReset }: { error: Error; onReset: () => void }): ReactNode {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 p-8 font-sans">
			<div className="flex size-12 items-center justify-center rounded-lg bg-error-dim font-semibold text-error text-xl">
				!
			</div>
			<h2 className="m-0 font-semibold text-base text-foreground">Component Error</h2>
			<p className="m-0 max-w-[480px] text-center font-mono text-body text-foreground-muted">
				{error.message || "An unexpected error occurred in this component"}
			</p>
			<ErrorContextDetails error={error} />
			<Button
				className="mt-2 rounded-sm border border-border bg-surface-elevated px-5 py-2 font-medium font-mono text-body text-foreground transition-[background-color,border-color] duration-150 hover:bg-surface-hover"
				onClick={onReset}
			>
				Try again
			</Button>
		</div>
	);
}

/**
 * Error boundary component that catches React errors in child components.
 * Provides fallback UI and error logging.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: null };
	}

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { hasError: true, error };
	}

	override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
		const componentStack = errorInfo.componentStack ?? "No component stack available";

		// Log to console with full context. The main-process console-message
		// hook in electron/main.ts forwards these to debug.log; when Sentry is
		// enabled in main, the captured uncaught exception path picks them up
		// from there. No renderer-side Sentry SDK by design (see SENTRY.md).
		console.error("[ErrorBoundary] Caught error:", formatErrorForLog(error));
		console.error("[ErrorBoundary] Component stack:", componentStack);

		// Update state with error info
		this.setState({ errorInfo: componentStack });

		// Call custom error handler if provided
		this.props.onError?.(error, componentStack);
	}

	reset = (): void => {
		this.setState({ hasError: false, error: null, errorInfo: null });
	};

	private renderFallback(error: Error): ReactNode {
		if (this.props.fallback) {
			return this.props.fallback(error, this.state.errorInfo ?? "", this.reset);
		}
		return <DefaultFallback error={error} onReset={this.reset} />;
	}

	override render(): ReactNode {
		const { error, hasError } = this.state;
		if (hasError && error) {
			return this.renderFallback(error);
		}
		return this.props.children;
	}
}

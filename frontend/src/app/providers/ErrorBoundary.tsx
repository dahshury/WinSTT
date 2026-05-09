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

		// Log to console with full context
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

	override render(): ReactNode {
		if (this.state.hasError && this.state.error) {
			if (this.props.fallback) {
				return this.props.fallback(this.state.error, this.state.errorInfo ?? "", this.reset);
			}

			// Default fallback UI
			return (
				<div className="flex h-full flex-col items-center justify-center gap-4 p-8 font-sans">
					<div className="flex size-12 items-center justify-center rounded-lg bg-error-dim font-semibold text-error text-xl">
						!
					</div>

					<h2 className="m-0 font-semibold text-base text-foreground">Component Error</h2>

					<p className="m-0 max-w-[480px] text-center font-mono text-body text-foreground-muted">
						{this.state.error.message || "An unexpected error occurred in this component"}
					</p>

					{isApplicationError(this.state.error) && this.state.error.context && (
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
									<pre className="p-3">{JSON.stringify(this.state.error.context, null, 2)}</pre>
								</ScrollArea>
							</Collapsible.Panel>
						</Collapsible.Root>
					)}

					<Button
						className="mt-2 rounded-sm border border-border bg-surface-elevated px-5 py-2 font-medium font-mono text-body text-foreground transition-[background-color,border-color] duration-150 hover:bg-surface-hover"
						onClick={this.reset}
					>
						Try again
					</Button>
				</div>
			);
		}

		return this.props.children;
	}
}

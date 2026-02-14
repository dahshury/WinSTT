"use client";

import { Component, type ReactNode } from "react";
import { formatErrorForLog, isApplicationError } from "@/shared/lib/errors";

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: (error: Error, errorInfo: string, reset: () => void) => ReactNode;
	onError?: (error: Error, errorInfo: string) => void;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	errorInfo: string | null;
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
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						height: "100%",
						gap: "16px",
						padding: "32px",
						fontFamily: "var(--font-sans)",
					}}
				>
					<div
						style={{
							width: "48px",
							height: "48px",
							borderRadius: "var(--radius-lg)",
							backgroundColor: "var(--color-error-dim)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: "20px",
							fontWeight: 600,
							color: "var(--color-error)",
						}}
					>
						!
					</div>

					<h2
						style={{
							fontSize: "16px",
							fontWeight: 600,
							color: "var(--color-text-primary)",
							margin: 0,
						}}
					>
						Component Error
					</h2>

					<p
						style={{
							fontSize: "13px",
							color: "var(--color-text-muted)",
							textAlign: "center",
							maxWidth: "480px",
							margin: 0,
							fontFamily: "var(--font-mono)",
						}}
					>
						{this.state.error.message || "An unexpected error occurred in this component"}
					</p>

					{isApplicationError(this.state.error) && this.state.error.context && (
						<details
							style={{
								fontSize: "12px",
								color: "var(--color-text-muted)",
								maxWidth: "480px",
								marginTop: "8px",
							}}
						>
							<summary style={{ cursor: "pointer", fontWeight: 500 }}>Error Details</summary>
							<pre
								style={{
									marginTop: "8px",
									padding: "12px",
									backgroundColor: "var(--color-bg-elevated)",
									borderRadius: "var(--radius-sm)",
									overflow: "auto",
									maxHeight: "200px",
								}}
							>
								{JSON.stringify(this.state.error.context, null, 2)}
							</pre>
						</details>
					)}

					<button
						onClick={this.reset}
						style={{
							marginTop: "8px",
							padding: "8px 20px",
							fontSize: "13px",
							fontWeight: 500,
							fontFamily: "var(--font-mono)",
							color: "var(--color-text-primary)",
							backgroundColor: "var(--color-bg-elevated)",
							border: "1px solid var(--color-border)",
							borderRadius: "var(--radius-sm)",
							cursor: "pointer",
							transition: "background-color 150ms, border-color 150ms",
						}}
						type="button"
					>
						Try again
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}

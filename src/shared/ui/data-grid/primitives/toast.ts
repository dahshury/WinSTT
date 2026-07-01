/**
 * Minimal `sonner`-compatible toast for the vendored DiceUI data grid.
 *
 * WinSTT ships no toast library; the grid only needs transient, non-blocking
 * feedback ("3 rows deleted", "Invalid URL", "No actions to undo"). This is a
 * tiny imperative shim exposing the `toast.{success,error,info,warning}` surface
 * the grid calls, rendered into a fixed bottom-center stack and themed with the
 * app's surface CSS variables. Safe to call in non-DOM (test) environments.
 */

type ToastKind = "success" | "error" | "info" | "warning";

interface ToastOptions {
	description?: string;
	duration?: number;
}

const ACCENT: Record<ToastKind, string> = {
	success: "var(--color-success)",
	error: "var(--color-error)",
	info: "var(--color-accent)",
	warning: "var(--color-warning)",
};

let container: HTMLElement | null = null;

function getContainer(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	if (container?.isConnected) return container;
	container = document.createElement("div");
	container.setAttribute("data-data-grid-toaster", "");
	container.style.cssText = [
		"position:fixed",
		"bottom:1rem",
		"left:50%",
		"transform:translateX(-50%)",
		"display:flex",
		"flex-direction:column",
		"gap:0.5rem",
		"z-index:2147483000",
		"pointer-events:none",
		"max-width:min(92vw,420px)",
	].join(";");
	document.body.appendChild(container);
	return container;
}

function show(kind: ToastKind, message: string, opts?: ToastOptions): void {
	const root = getContainer();
	if (!root) return;

	const el = document.createElement("div");
	el.setAttribute("role", kind === "error" ? "alert" : "status");
	el.style.cssText = [
		"pointer-events:auto",
		"display:flex",
		"flex-direction:column",
		"gap:2px",
		"padding:0.55rem 0.8rem",
		"border-radius:0.5rem",
		"font-family:var(--font-sans,system-ui)",
		"font-size:12.5px",
		"line-height:1.35",
		"color:var(--color-foreground)",
		"background:var(--color-surface-6)",
		"border:1px solid var(--color-border)",
		`border-left:3px solid ${ACCENT[kind]}`,
		"box-shadow:var(--shadow-overlay)",
		"opacity:0",
		"transform:translateY(6px)",
		"transition:opacity 150ms ease,transform 150ms ease",
	].join(";");

	const title = document.createElement("span");
	title.style.fontWeight = "500";
	title.textContent = message;
	el.appendChild(title);

	if (opts?.description) {
		const desc = document.createElement("span");
		desc.style.cssText = "color:var(--color-foreground-muted);font-size:11.5px";
		desc.textContent = opts.description;
		el.appendChild(desc);
	}

	root.appendChild(el);
	requestAnimationFrame(() => {
		el.style.opacity = "1";
		el.style.transform = "translateY(0)";
	});

	const duration = opts?.duration ?? 3200;
	window.setTimeout(() => {
		el.style.opacity = "0";
		el.style.transform = "translateY(6px)";
		window.setTimeout(() => el.remove(), 180);
	}, duration);
}

type ToastFn = ((message: string, opts?: ToastOptions) => void) & {
	error: (message: string, opts?: ToastOptions) => void;
	info: (message: string, opts?: ToastOptions) => void;
	success: (message: string, opts?: ToastOptions) => void;
	warning: (message: string, opts?: ToastOptions) => void;
};

export const toast: ToastFn = Object.assign(
	(message: string, opts?: ToastOptions) => show("info", message, opts),
	{
		error: (message: string, opts?: ToastOptions) =>
			show("error", message, opts),
		info: (message: string, opts?: ToastOptions) => show("info", message, opts),
		success: (message: string, opts?: ToastOptions) =>
			show("success", message, opts),
		warning: (message: string, opts?: ToastOptions) =>
			show("warning", message, opts),
	},
);

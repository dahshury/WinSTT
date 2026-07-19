import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import { commands, type PermissionPreflightStatus } from "@/bindings";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";

type PermissionKind = "microphone" | "accessibility";
type PermissionCommandResult = Awaited<
	ReturnType<typeof commands.permissionRunPreflight>
>;

type PermissionOutcome =
	| { kind: "success"; status: PermissionPreflightStatus }
	| { kind: "error"; message: string };

type PermissionViewState =
	| {
			phase: "checking";
			error: null;
			status: PermissionPreflightStatus | null;
	  }
	| {
			phase: "settled";
			error: string | null;
			status: PermissionPreflightStatus | null;
	  };

interface PermissionPreflightController {
	busy: boolean;
	error: string | null;
	request: (kind: PermissionKind) => void;
	retry: () => void;
	status: PermissionPreflightStatus | null;
}

const BROWSER_PERMISSION_STATUS: PermissionPreflightStatus = {
	accessibility: "not_required",
	microphone: "not_required",
	platform: "other",
	ready: true,
};

function initialPermissionState(): PermissionViewState {
	if (hasTauriRuntime()) {
		return { error: null, phase: "checking", status: null };
	}
	return {
		error: null,
		phase: "settled",
		status: BROWSER_PERMISSION_STATUS,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function permissionOutcome(result: PermissionCommandResult): PermissionOutcome {
	if (result.status === "error") {
		return { kind: "error", message: result.error };
	}
	return { kind: "success", status: result.data };
}

function failedPermissionOutcome(error: unknown): PermissionOutcome {
	return { kind: "error", message: errorMessage(error) };
}

function settledPermissionState(
	current: PermissionViewState,
	outcome: PermissionOutcome,
): PermissionViewState {
	if (outcome.kind === "error") {
		return {
			error: outcome.message,
			phase: "settled",
			status: current.status,
		};
	}
	return { error: null, phase: "settled", status: outcome.status };
}

function acceptPermissionOutcome(
	outcome: PermissionOutcome,
	operationId: number,
	operationIdRef: RefObject<number>,
	awaitingGrantRef: RefObject<boolean>,
	setState: Dispatch<SetStateAction<PermissionViewState>>,
): void {
	if (operationIdRef.current !== operationId) {
		return;
	}
	if (outcome.kind === "success" && outcome.status.ready) {
		awaitingGrantRef.current = false;
	}
	setState((current) => settledPermissionState(current, outcome));
}

function beginPermissionOperation(
	operationIdRef: RefObject<number>,
	setState: Dispatch<SetStateAction<PermissionViewState>>,
): number {
	operationIdRef.current += 1;
	setState((current) => ({
		error: null,
		phase: "checking",
		status: current.status,
	}));
	return operationIdRef.current;
}

function runPermissionPreflight(
	inFlightRef: RefObject<Promise<PermissionOutcome> | null>,
): Promise<PermissionOutcome> {
	const inFlight = inFlightRef.current;
	if (inFlight) {
		return inFlight;
	}

	const request = hasTauriRuntime()
		? commands
				.permissionRunPreflight()
				.then(permissionOutcome, failedPermissionOutcome)
		: Promise.resolve<PermissionOutcome>({
				kind: "success",
				status: BROWSER_PERMISSION_STATUS,
			});
	inFlightRef.current = request;
	void request.then(() => {
		if (inFlightRef.current === request) {
			inFlightRef.current = null;
		}
	});
	return request;
}

function requestSystemPermission(
	kind: PermissionKind,
): Promise<PermissionOutcome> {
	const request =
		kind === "microphone"
			? commands.permissionRequestMicrophone()
			: commands.permissionRequestAccessibility();
	return request.then(permissionOutcome, failedPermissionOutcome);
}

export function usePermissionPreflight(): PermissionPreflightController {
	const [state, setState] = useState<PermissionViewState>(
		initialPermissionState,
	);
	const awaitingGrantRef = useRef(false);
	const operationIdRef = useRef(0);
	const preflightInFlightRef = useRef<Promise<PermissionOutcome> | null>(null);
	const permissionRequestInFlightRef = useRef(false);

	const acceptOutcome = (outcome: PermissionOutcome, operationId: number) => {
		acceptPermissionOutcome(
			outcome,
			operationId,
			operationIdRef,
			awaitingGrantRef,
			setState,
		);
	};

	const retry = () => {
		if (permissionRequestInFlightRef.current) {
			return;
		}
		const operationId = beginPermissionOperation(operationIdRef, setState);
		void runPermissionPreflight(preflightInFlightRef).then((outcome) => {
			acceptOutcome(outcome, operationId);
		});
	};

	const request = (kind: PermissionKind) => {
		if (permissionRequestInFlightRef.current) {
			return;
		}
		permissionRequestInFlightRef.current = true;
		// A preflight started before the OS prompt is an obsolete snapshot. It may
		// finish, but cannot be reused by the post-prompt recheck.
		preflightInFlightRef.current = null;
		awaitingGrantRef.current = true;
		const operationId = beginPermissionOperation(operationIdRef, setState);
		void requestSystemPermission(kind).then((outcome) => {
			permissionRequestInFlightRef.current = false;
			acceptOutcome(outcome, operationId);
		});
	};

	// The initial native check is rendering-driven synchronization. Browser
	// previews are already settled by the lazy state initializer, so they need no
	// Effect-driven state correction.
	useEffect(() => {
		const operationId = operationIdRef.current;
		if (hasTauriRuntime()) {
			void runPermissionPreflight(preflightInFlightRef).then((outcome) => {
				acceptPermissionOutcome(
					outcome,
					operationId,
					operationIdRef,
					awaitingGrantRef,
					setState,
				);
			});
		}
		return () => {
			// Invalidates any unresolved operation on unmount and during Strict Mode's
			// setup/cleanup replay without cancelling the shared native request.
			operationIdRef.current += 1;
		};
	}, []);

	const recheckOnReturn = useEffectEvent(() => {
		if (document.visibilityState === "visible") {
			retry();
		}
	});

	// System privacy panels live outside the webview. Recheck while waiting for a
	// grant and immediately when the user returns, then stop polling once ready.
	useEffect(() => {
		const handleReturn = () => {
			recheckOnReturn();
		};
		const pollWhileWaiting = () => {
			if (awaitingGrantRef.current) {
				recheckOnReturn();
			}
		};
		window.addEventListener("focus", handleReturn);
		document.addEventListener("visibilitychange", handleReturn);
		const poll = window.setInterval(pollWhileWaiting, 1000);
		return () => {
			window.removeEventListener("focus", handleReturn);
			document.removeEventListener("visibilitychange", handleReturn);
			window.clearInterval(poll);
		};
	}, []);

	return {
		busy: state.phase === "checking",
		error: state.error,
		request,
		retry,
		status: state.status,
	};
}

import { useEffect, useReducer, useRef, useState } from "react";
import { detectOllama, startOllama } from "@/shared/api/ipc-client";
import {
	DialogActionButton,
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
} from "@/shared/ui/dialog";
import { Modal } from "@/shared/ui/modal";
import { PasswordField } from "@/shared/ui/text-field";
import type { TranslateFn } from "./types";

interface DialogProps {
	t: TranslateFn;
	tc: TranslateFn;
}

interface OllamaDialogProps extends DialogProps {
	isOpen: boolean;
	onClose: () => void;
	onStarted: () => void;
}

function openSignup(): void {
	window.open("https://openrouter.ai/keys", "_blank", "noopener,noreferrer");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface OllamaDialogTexts {
	description: string;
	title: string;
}

function getOllamaDialogTexts(
	showRun: boolean,
	t: TranslateFn,
): OllamaDialogTexts {
	if (showRun) {
		return {
			title: t("ollamaNotRunning"),
			description: t("ollamaNotRunningDescription"),
		};
	}
	return {
		title: t("ollamaRequired"),
		description: t("ollamaRequiredDescription"),
	};
}

function OllamaStartErrorBanner({ message }: { message: string | null }) {
	if (!message) {
		return null;
	}
	return (
		<div className="rounded bg-error/10 p-2 text-error text-xs">{message}</div>
	);
}

interface OllamaPrimaryButtonProps {
	detecting: boolean;
	onDownload: () => void;
	onStart: () => void;
	showRun: boolean;
	starting: boolean;
	t: TranslateFn;
}

function OllamaPrimaryButton(props: OllamaPrimaryButtonProps) {
	const { detecting, showRun, starting, t, onStart, onDownload } = props;
	if (showRun) {
		return (
			<DialogActionButton
				disabled={detecting || starting}
				onClick={onStart}
				variant="accent"
			>
				{starting ? t("starting") : t("runOllama")}
			</DialogActionButton>
		);
	}
	return (
		<DialogActionButton
			disabled={detecting || starting}
			onClick={onDownload}
			variant="accent"
		>
			{t("downloadOllama")}
		</DialogActionButton>
	);
}

interface OllamaDialogState {
	installed: boolean | null;
	startError: string | null;
	starting: boolean;
}

type OllamaDialogAction =
	| { type: "reset-status" }
	| { type: "detect-failed"; error: string }
	| { type: "set-installed"; value: boolean | null }
	| { type: "start-attempt" }
	| { type: "start-failed"; error: string }
	| { type: "start-succeeded" };

function ollamaDialogReducer(
	state: OllamaDialogState,
	action: OllamaDialogAction,
): OllamaDialogState {
	switch (action.type) {
		case "reset-status":
			return INITIAL_OLLAMA_DIALOG_STATE;
		case "detect-failed":
			return {
				...state,
				installed: false,
				starting: false,
				startError: action.error,
			};
		case "set-installed":
			return { ...state, installed: action.value, startError: null };
		case "start-attempt":
			return { ...state, starting: true, startError: null };
		case "start-failed":
			return { ...state, starting: false, startError: action.error };
		case "start-succeeded":
			return { ...state, starting: false };
		default:
			return state;
	}
}

const INITIAL_OLLAMA_DIALOG_STATE: OllamaDialogState = {
	installed: null,
	starting: false,
	startError: null,
};

export function OllamaDialog({
	t,
	tc,
	isOpen,
	onClose,
	onStarted,
}: OllamaDialogProps) {
	const [state, dispatch] = useReducer(
		ollamaDialogReducer,
		INITIAL_OLLAMA_DIALOG_STATE,
	);
	const { installed, starting, startError } = state;
	const isOpenRef = useRef(isOpen);
	const isMountedRef = useRef(true);
	const activeStartRef = useRef<symbol | null>(null);

	useEffect(() => {
		isOpenRef.current = isOpen;
		if (!isOpen) {
			activeStartRef.current = null;
		}
	}, [isOpen]);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			activeStartRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		dispatch({ type: "reset-status" });
		let cancelled = false;
		(async () => {
			try {
				const result = await detectOllama();
				if (!cancelled) {
					dispatch({ type: "set-installed", value: result.installed });
				}
			} catch (err) {
				if (!cancelled) {
					dispatch({
						type: "detect-failed",
						error: errorMessage(err) || t("ollamaStartFailed"),
					});
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isOpen, t]);

	const openDownload = () => {
		window.open("https://ollama.com", "_blank", "noopener,noreferrer");
		onClose();
	};

	const handleStart = async () => {
		const startAttempt = Symbol("ollama-start-attempt");
		activeStartRef.current = startAttempt;
		const isCurrentStart = () =>
			isMountedRef.current &&
			isOpenRef.current &&
			activeStartRef.current === startAttempt;
		dispatch({ type: "start-attempt" });
		let result: Awaited<ReturnType<typeof startOllama>>;
		try {
			result = await startOllama();
		} catch (err) {
			if (isCurrentStart()) {
				activeStartRef.current = null;
				dispatch({
					type: "start-failed",
					error: errorMessage(err) || t("ollamaStartFailed"),
				});
			}
			return;
		}
		if (!isCurrentStart()) {
			return;
		}
		activeStartRef.current = null;
		if (!result.started) {
			dispatch({
				type: "start-failed",
				error: result.error ?? t("ollamaStartFailed"),
			});
			return;
		}
		dispatch({ type: "start-succeeded" });
		onStarted();
	};

	const showRun = installed === true;
	const detecting = installed === null;
	const { title, description } = getOllamaDialogTexts(showRun, t);

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex w-[28rem] max-w-[90vw] flex-col">
				<DialogHeader
					closeLabel={tc("close")}
					onClose={onClose}
					rail
					title={title}
				/>
				<DialogBody className="flex flex-col gap-3">
					<DialogDescription>{description}</DialogDescription>
					<OllamaStartErrorBanner message={startError} />
				</DialogBody>
				<DialogFooter bar>
					<DialogActionButton
						disabled={starting}
						onClick={onClose}
						variant="neutral"
					>
						{tc("cancel")}
					</DialogActionButton>
					<OllamaPrimaryButton
						detecting={detecting}
						onDownload={openDownload}
						onStart={handleStart}
						showRun={showRun}
						starting={starting}
						t={t}
					/>
				</DialogFooter>
			</div>
		</Modal>
	);
}

interface ApiKeyDialogProps extends DialogProps {
	initialKey: string;
	isOpen: boolean;
	onClose: () => void;
	onSave: (key: string) => void;
}

function ApiKeyDialogBody({
	t,
	tc,
	onClose,
	onSave,
}: {
	t: TranslateFn;
	tc: TranslateFn;
	onClose: () => void;
	onSave: (key: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState("");
	const hasValue = value.trim().length > 0;

	// Focus the field on open. The body is mounted only while the dialog is open
	// (see ApiKeyDialog), so a fresh mount both blanks `value` and focuses — no
	// prop-driven reset effect needed. This is only an external-DOM side effect.
	useEffect(() => {
		const id = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(id);
	}, []);

	const submit = () => {
		const trimmed = value.trim();
		if (!trimmed) {
			return;
		}
		onSave(trimmed);
	};

	return (
		<div className="flex w-[30rem] max-w-[90vw] flex-col">
			<DialogHeader
				closeLabel={tc("close")}
				onClose={onClose}
				rail
				title={t("apiKeyRequired")}
			/>
			<DialogBody className="flex flex-col gap-3">
				<DialogDescription>{t("apiKeyRequiredDescription")}</DialogDescription>
				<PasswordField
					hideLabel={tc("hidePassword")}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							submit();
						}
					}}
					placeholder={t("openrouterApiKeyPlaceholder")}
					ref={inputRef}
					revealLabel={tc("showPassword")}
					value={value}
				/>
			</DialogBody>
			{/* "Get an API key" leaves the app to a signup page — it is a side
			    door, not a peer of Cancel/Save, so it sits on the leading edge
			    rather than in the action group. */}
			<DialogFooter
				bar
				leading={
					<DialogActionButton onClick={openSignup} variant="neutral">
						{t("getApiKey")}
					</DialogActionButton>
				}
			>
				<DialogActionButton onClick={onClose} variant="neutral">
					{tc("cancel")}
				</DialogActionButton>
				<DialogActionButton
					disabled={!hasValue}
					onClick={submit}
					variant="accent"
				>
					{t("saveAndEnable")}
				</DialogActionButton>
			</DialogFooter>
		</div>
	);
}

export function ApiKeyDialog({
	t,
	tc,
	isOpen,
	onClose,
	onSave,
	initialKey: _initialKey,
}: ApiKeyDialogProps) {
	// Mount the body only while open so each open re-seeds a blank field (and
	// resets PasswordField's reveal state) via a fresh mount — no reset effect.
	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			{isOpen ? (
				<ApiKeyDialogBody onClose={onClose} onSave={onSave} t={t} tc={tc} />
			) : null}
		</Modal>
	);
}

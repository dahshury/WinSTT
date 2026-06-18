import { useEffect, useReducer, useRef, useState } from "react";
import type { useTranslations } from "use-intl";
import { detectOllama, startOllama } from "@/shared/api/ipc-client";
import {
	DialogActionButton,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/shared/ui/dialog";
import { Modal } from "@/shared/ui/modal";
import { PasswordField } from "@/shared/ui/text-field";
import { getOllamaDialogTexts } from "../lib/llm-settings-panel-test-helpers";
import type { TranslateFn } from "./types";

interface DialogProps {
	t: ReturnType<typeof useTranslations>;
	tc: ReturnType<typeof useTranslations>;
}

interface OllamaDialogProps extends DialogProps {
	isOpen: boolean;
	onClose: () => void;
	onStarted: () => void;
}

function openSignup(): void {
	window.open("https://openrouter.ai/keys", "_blank");
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
	onDownload: () => void;
	onStart: () => void;
	showRun: boolean;
	starting: boolean;
	t: TranslateFn;
}

function OllamaPrimaryButton(props: OllamaPrimaryButtonProps) {
	const { showRun, starting, t, onStart, onDownload } = props;
	if (showRun) {
		return (
			<DialogActionButton
				disabled={starting}
				onClick={onStart}
				variant="accent"
			>
				{starting ? t("starting") : t("runOllama")}
			</DialogActionButton>
		);
	}
	return (
		<DialogActionButton onClick={onDownload} variant="accent">
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
			return { ...state, startError: null, starting: false };
		case "set-installed":
			return { ...state, installed: action.value };
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

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		dispatch({ type: "reset-status" });
		let cancelled = false;
		(async () => {
			const result = await detectOllama();
			if (!cancelled) {
				dispatch({ type: "set-installed", value: result.installed });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isOpen]);

	const openDownload = () => {
		window.open("https://ollama.com", "_blank");
		onClose();
	};

	const handleStart = async () => {
		dispatch({ type: "start-attempt" });
		const result = await startOllama();
		if (!result.started) {
			dispatch({
				type: "start-failed",
				error: result.error ?? t("ollamaStartFailed"),
			});
			return;
		}
		setTimeout(() => {
			dispatch({ type: "start-succeeded" });
			onStarted();
		}, 1500);
	};

	const showRun = installed === true;
	const { title, description } = getOllamaDialogTexts(showRun, t);

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex w-[28rem] max-w-[90vw] flex-col gap-4 p-6">
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>{description}</DialogDescription>
				<OllamaStartErrorBanner message={startError} />
				<DialogFooter>
					<DialogActionButton
						disabled={starting}
						onClick={onClose}
						variant="neutral"
					>
						{tc("cancel")}
					</DialogActionButton>
					<OllamaPrimaryButton
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

export function ApiKeyDialog({
	t,
	tc,
	isOpen,
	onClose,
	onSave,
	initialKey,
}: ApiKeyDialogProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [hasValue, setHasValue] = useState(initialKey.trim().length > 0);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const id = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(id);
	}, [isOpen]);

	const submit = () => {
		const trimmed = (inputRef.current?.value ?? "").trim();
		if (!trimmed) {
			return;
		}
		onSave(trimmed);
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex w-[30rem] max-w-[90vw] flex-col gap-4 p-6">
				<DialogTitle>{t("apiKeyRequired")}</DialogTitle>
				<DialogDescription>{t("apiKeyRequiredDescription")}</DialogDescription>
				<PasswordField
					defaultValue={initialKey}
					hideLabel={tc("hidePassword")}
					key={isOpen ? "open" : "closed"}
					onChange={(e) => setHasValue(e.target.value.trim().length > 0)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							submit();
						}
					}}
					placeholder={t("openrouterApiKeyPlaceholder")}
					ref={inputRef}
					revealLabel={tc("showPassword")}
				/>
				<DialogFooter>
					<DialogActionButton onClick={openSignup} variant="neutral">
						{t("getApiKey")}
					</DialogActionButton>
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
		</Modal>
	);
}

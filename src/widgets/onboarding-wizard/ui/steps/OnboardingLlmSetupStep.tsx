import { Button as BaseButton } from "@base-ui/react/button";
import {
	ArrowUpRight01Icon,
	CheckmarkCircle02Icon,
	Cursor01Icon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { useSettingsStore } from "@/entities/setting";
import {
	detectOllama,
	type OllamaDetectResult,
	startOllama,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { ollamaLlmSelectorUiStorageKey } from "@/shared/lib/model-picker-ui-storage-keys";
import { FormControl } from "@/shared/ui/form-control";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { Toggle } from "@/shared/ui/toggle";
import { OllamaModelSelector } from "@/widgets/model-picker";
import { useOnboardingOllamaPicker } from "../../model/use-onboarding-ollama-picker";

const OLLAMA_HOMEPAGE = "https://ollama.com/download";
const START_BUTTON_MOTION_PROPS = {
	whileHover: { y: -1 },
	whileTap: { scale: 0.97 },
} as const;
const MotionBaseButton = m.create(BaseButton);

/**
 * Step 4: optional LLM cleanup. Tries to detect Ollama (`detectOllama` returns
 * `{ installed }` — `installed=true` means the daemon is reachable on the
 * default port, false means either not installed or not running). When
 * available, the user picks a model with the SAME rich inline
 * `OllamaModelSelector` used in Settings → LLM (browse / install / delete /
 * quant-shelf all happen in the dropdown) and toggles dictation cleanup with the
 * canonical `Toggle` switch.
 *
 * Per the capability-toggle invariant (memory: feedback_capability_must_have_model)
 * we never flip `llm.dictation.enabled` true without first writing a real
 * model id into `llm.dictation.model`.
 */
export function OnboardingLlmSetupStep() {
	const t = useTranslations("onboarding");
	const reduceMotion = useReducedMotion();
	const [detect, setDetect] = useState<OllamaDetectResult | null>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [configuring, setConfiguring] = useState(false);
	const llmDictation = useSettingsStore((s) => s.settings.llm.dictation);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const installedModels = useLlmCatalogStore((s) => s.models);
	const scanModels = useLlmCatalogStore((s) => s.scanModels);
	const pickerProps = useOnboardingOllamaPicker();

	useEffect(() => {
		let cancelled = false;
		detectOllama()
			.then((result) => {
				if (!cancelled) {
					setDetect(result);
					if (result.installed) {
						fireAndForget(scanModels(), "onboarding.llmSetup.scanModels");
					}
				}
			})
			.catch(() => {
				if (!cancelled) {
					setDetect({ installed: false });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [scanModels]);

	if (!detect) {
		return (
			<AnimatePresence initial={false} mode="wait">
				<m.div
					animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
					className="flex items-center gap-2 px-1 py-1.5 text-body-sm text-foreground-muted"
					exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
					initial={
						reduceMotion ? false : { opacity: 0, y: 4, filter: "blur(2px)" }
					}
					key="detecting"
					transition={{
						duration: reduceMotion ? 0 : 0.18,
						ease: [0.22, 1, 0.36, 1],
					}}
				>
					<PulseDot className="size-2" />
					<span>{t("lookingForOllama")}</span>
				</m.div>
			</AnimatePresence>
		);
	}

	if (!detect.installed) {
		return (
			<AnimatePresence initial={false} mode="wait">
				<m.div
					animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
					exit={{ opacity: 0, y: -5, filter: "blur(2px)" }}
					initial={
						reduceMotion ? false : { opacity: 0, y: 6, filter: "blur(3px)" }
					}
					key="not-installed"
					transition={{
						duration: reduceMotion ? 0 : 0.2,
						ease: [0.22, 1, 0.36, 1],
					}}
				>
					<NotInstalledPanel
						error={startError}
						onStart={() => {
							setStarting(true);
							setStartError(null);
							startOllama()
								.then((result) => {
									if (result.started) {
										return detectOllama().then(setDetect);
									}
									setStartError(result.error ?? t("couldNotStartOllama"));
									return;
								})
								.finally(() => setStarting(false));
						}}
						starting={starting}
					/>
				</m.div>
			</AnimatePresence>
		);
	}

	const enabled = llmDictation.enabled;
	const selectedModel = llmDictation.model;
	const isInstalled =
		!!selectedModel && installedModels.some((m) => m.name === selectedModel);

	// Post-processing is OPT-IN. The "Clean up dictation" toggle is the primary
	// control; the model picker only appears once cleanup is on — so leaving the
	// toggle off (the default) is a zero-click "no post-processing at all" with
	// nothing to choose. `configuring` covers the one case the toggle can't
	// resolve by itself: turning cleanup on while NO model is installed yet, where
	// we reveal the picker so the user can install one first.
	const showModelPicker = enabled || configuring;

	// Picking a model records it (provider + id). If the user reached the picker by
	// switching cleanup on with nothing installed, completing a pick also flips the
	// feature on — the capability invariant only needs a real model, and now there
	// is one (feedback_capability_must_have_model).
	const handleSelectModel = (name: string) => {
		updateLlmDictation(
			configuring && !enabled
				? { enabled: true, model: name, provider: "ollama" }
				: { model: name, provider: "ollama" },
		);
	};

	const handleToggle = (next: boolean) => {
		if (!next) {
			// Opting out is a single click — collapse the picker so the step reads
			// as "no post-processing", not "you still have to pick a model".
			updateLlmDictation({ enabled: false });
			setConfiguring(false);
			return;
		}
		// Never enable without a real, installed model (feedback_capability_must_have_model).
		// If the current pick is installed, enable immediately; otherwise fall back
		// to the first installed model.
		if (isInstalled) {
			updateLlmDictation({
				enabled: true,
				model: selectedModel,
				provider: "ollama",
			});
			return;
		}
		const fallback = installedModels[0]?.name;
		if (fallback) {
			updateLlmDictation({
				enabled: true,
				model: fallback,
				provider: "ollama",
			});
			return;
		}
		// Nothing installed to enable with yet — reveal the picker so the user can
		// install a model; the feature flips on once one lands (handleSelectModel).
		setConfiguring(true);
	};

	return (
		<AnimatePresence initial={false} mode="wait">
			<m.div
				animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
				className="flex flex-col gap-3"
				exit={{ opacity: 0, y: -5, filter: "blur(2px)" }}
				initial={
					reduceMotion ? false : { opacity: 0, y: 6, filter: "blur(3px)" }
				}
				key="installed"
				transition={{
					duration: reduceMotion ? 0 : 0.2,
					ease: [0.22, 1, 0.36, 1],
				}}
			>
				<m.div
					animate={{ opacity: 1, scale: 1, y: 0 }}
					className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-body-sm text-success ring-1 ring-success/25"
					initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 4 }}
					transition={{ type: "spring", stiffness: 580, damping: 34 }}
				>
					<m.span
						animate={{ rotate: 0, scale: 1 }}
						className="inline-flex"
						initial={reduceMotion ? false : { rotate: -28, scale: 0.55 }}
						transition={{ type: "spring", stiffness: 700, damping: 26 }}
					>
						<HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} />
					</m.span>
					<span className="font-medium">{t("ollamaRunning")}</span>
				</m.div>

				<FormControl
					caption={t("cleanUpDictationCaption")}
					label={t("cleanUpDictation")}
					layout="row"
				>
					<Toggle
						aria-label={t("cleanUpDictationAria")}
						checked={enabled}
						onCheckedChange={handleToggle}
					/>
				</FormControl>

				{showModelPicker ? (
					<FormControl
						caption={t("modelCaption")}
						label={t("modelLabel")}
						layout="stacked"
					>
						<OllamaModelSelector
							{...pickerProps}
							onChange={handleSelectModel}
							placeholder={t("noModelSelected")}
							uiStorageKey={ollamaLlmSelectorUiStorageKey("dictation")}
							value={selectedModel}
						/>
					</FormControl>
				) : (
					<p className="px-1 text-body-sm text-foreground-muted leading-snug">
						{t("finishWithoutOllama")}
					</p>
				)}
			</m.div>
		</AnimatePresence>
	);
}

interface NotInstalledPanelProps {
	error: string | null;
	onStart: () => void;
	starting: boolean;
}

function NotInstalledPanel({
	error,
	starting,
	onStart,
}: NotInstalledPanelProps) {
	const t = useTranslations("onboarding");
	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-md bg-surface-2 px-4 py-3 ring-1 ring-divider">
				<div className="flex items-center gap-2 font-medium text-body text-foreground">
					<HugeiconsIcon
						className="text-foreground-muted"
						icon={Download04Icon}
						size={14}
					/>
					{t("ollamaNotRunning")}
				</div>
				<p className="mt-1.5 text-body-sm text-foreground-muted leading-snug">
					{t("ollamaNotRunningBody")}
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-2.5">
					<MotionBaseButton
						className={cn(
							"inline-flex h-7 items-center justify-center rounded-md bg-accent px-3 font-medium text-body-sm text-on-accent outline-none transition-[background-color,box-shadow] duration-150",
							"shadow-elevated hover:bg-accent-hover",
							"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
							"disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
						)}
						disabled={starting}
						onClick={onStart}
						whileHover={START_BUTTON_MOTION_PROPS.whileHover}
						whileTap={START_BUTTON_MOTION_PROPS.whileTap}
						type="button"
					>
						<AnimatePresence initial={false} mode="wait">
							<m.span
								animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
								exit={{ opacity: 0, y: -3, filter: "blur(2px)" }}
								initial={{ opacity: 0, y: 3, filter: "blur(2px)" }}
								key={starting ? "starting" : "start"}
								transition={{ duration: 0.14, ease: "easeInOut" }}
							>
								{starting ? t("startingOllama") : t("tryStartOllama")}
							</m.span>
						</AnimatePresence>
					</MotionBaseButton>
					<a
						className="inline-flex items-center gap-1 font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.16em] underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
						href={OLLAMA_HOMEPAGE}
						rel="noreferrer noopener"
						target="_blank"
					>
						<HugeiconsIcon icon={Cursor01Icon} size={10} />
						{t("installOllama")}
						<HugeiconsIcon icon={ArrowUpRight01Icon} size={10} />
					</a>
				</div>
				<AnimatePresence initial={false}>
					{error ? (
						<m.p
							animate={{ opacity: 1, x: 0 }}
							className="mt-2 text-body-sm text-error"
							exit={{ opacity: 0, x: -4 }}
							initial={{ opacity: 0, x: 4 }}
							transition={{ duration: 0.16, ease: "easeInOut" }}
						>
							{error}
						</m.p>
					) : null}
				</AnimatePresence>
			</div>
			<p className="text-body-sm text-foreground-dim">
				{t("finishWithoutOllama")}
			</p>
		</div>
	);
}

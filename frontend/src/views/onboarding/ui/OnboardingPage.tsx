import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSettingsStore } from "@/entities/setting";
import { useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf } from "@/shared/api/ipc-client";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";
import { OllamaModelManagerDialog } from "@/widgets/ollama-model-manager";
import { OnboardingWizard, useOnboardingWizardStore } from "@/widgets/onboarding-wizard";

/**
 * First-run wizard view. Mirrors the SettingsPage shell so the window reads
 * as first-party WinSTT chrome rather than a tacked-on dialog:
 *
 *   - Page substrate: surface-1 with the ambient noise overlay.
 *   - Titlebar: 32px frameless bar, surface-2 (Elevated offset=1) with a
 *     Docker-blue hairline at the very top, a glowing accent dot, mono-caps
 *     "WinSTT Setup" title, and a close button on the trailing edge that
 *     turns red on hover. The whole strip is draggable except the close.
 *   - Body: a second Elevated viewport (also surface-2 in effective level)
 *     so the wizard's section cards lift to surface-3 just like Settings.
 *
 * `useSyncSettings()` is what makes the wizard's settings mutations (mic
 * device, API keys, LLM dictation enable + model) actually round-trip to
 * the main process's electron-store. Without it, those choices would live
 * only in this window's zustand store and disappear when the wizard closes.
 */
export function OnboardingPage() {
	useSyncSettings();
	// The Ollama model-picker dialog lives here at the view level rather than
	// inside the wizard widget because it's a sibling widget — widgets can't
	// import other widgets. The LLM step toggles `llmPickerOpen` in the
	// wizard store; we read that flag and render the dialog wired to the
	// settings store so installs persist into `llm.dictation.model`.
	const llmPickerOpen = useOnboardingWizardStore((s) => s.llmPickerOpen);
	const setLlmPickerOpen = useOnboardingWizardStore((s) => s.setLlmPickerOpen);
	const llmDictation = useSettingsStore((s) => s.settings.llm.dictation);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);

	return (
		<SurfaceProvider value={1}>
			<div className="noise-overlay flex h-dvh min-h-dvh flex-col bg-surface-1">
				{/* Title bar — surface-2 substrate with a top-light gradient
				    overlay, a Docker-blue accent hairline at the top edge
				    (single brand moment, matching Settings), and a small accent
				    dot anchoring the title text. */}
				<Elevated
					className="titlebar-drag relative flex h-8 shrink-0 items-stretch border-border border-b bg-gradient-to-b from-[var(--color-surface-3)]/45 to-transparent"
					offset={1}
					shadowLevel={1}
				>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent"
					/>
					<div className="flex items-center gap-2 pl-3">
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--color-accent-glow-strong)]"
						/>
						<span className="font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.18em]">
							WinSTT Setup
						</span>
					</div>
					<div className="flex-1" />
					<div className="titlebar-no-drag flex items-center">
						<Tooltip content="Close">
							<Button
								aria-label="Close"
								className="group flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-error/85 hover:text-white"
								onClick={windowCloseSelf}
							>
								<HugeiconsIcon
									className="transition-transform duration-150 ease-out group-hover:scale-110"
									icon={Cancel01Icon}
									size={12}
								/>
							</Button>
						</Tooltip>
					</div>
				</Elevated>

				{/* Content viewport — lifts to surface-2 so wizard's section
				    cards (TextureCard offset=1) read at surface-3, matching the
				    settings panel substrate exactly. */}
				<Elevated className="flex flex-1 flex-col overflow-hidden" offset={1} shadowLevel={1}>
					<OnboardingWizard />
				</Elevated>
				<OllamaModelManagerDialog
					currentModel={llmDictation.model}
					isOpen={llmPickerOpen}
					onClose={() => setLlmPickerOpen(false)}
					onModelInstalled={(name) => updateLlmDictation({ model: name, provider: "ollama" })}
				/>
			</div>
		</SurfaceProvider>
	);
}

import {
	AiComputerIcon,
	CloudServerIcon,
	LockIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	CLOUD_PROVIDERS,
	defaultCloudModelId,
	providerOf,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import type { SwitcherOption } from "@/shared/ui/switcher";

type SttSource = "local" | "cloud";

/** Remembers the last cloud model the user actually landed on so flipping back
 *  to Cloud restores THAT concrete id instead of the provider's bare default —
 *  which, for OpenRouter, is `"openrouter:"` and forces the picker to wait on a
 *  live catalog scan before it can self-heal to a real row. */
const LAST_CLOUD_STT_MODEL_STORAGE_KEY = "winstt:last-cloud-stt-model";

function readLastCloudModel(): string | null {
	try {
		return (
			globalThis.localStorage?.getItem(LAST_CLOUD_STT_MODEL_STORAGE_KEY) ?? null
		);
	} catch {
		return null;
	}
}

function writeLastCloudModel(modelId: string): void {
	try {
		globalThis.localStorage?.setItem(LAST_CLOUD_STT_MODEL_STORAGE_KEY, modelId);
	} catch {
		// Ignore storage failures (private-mode quota, disabled storage) — the
		// default-cloud-model fallback still yields a usable selection.
	}
}

interface UseSttSourceSwitchArgs {
	/** True when at least one cloud provider has an API key — gates the Cloud
	 *  option (locked + lock badge when false). */
	hasAnyCloudKey: boolean;
	/** Initial source. Derive from `providerOf(model) !== null && hasAnyCloudKey`
	 *  and pass via a `key` on the host so a persisted-source flip re-mounts the
	 *  host and re-initialises this WITHOUT a derived-state effect. */
	initialSourceIsCloud: boolean;
	/** Lock-badge click when Cloud is disabled (no key) — context-specific:
	 *  settings switches to the Integrations tab, the detached window opens the
	 *  Settings window. */
	onConfigureCloud: () => void;
	/** Persist a model selection (drives the auto-pick on flipping source). */
	onModelChange: (modelId: string) => void;
	/** Resolve the local model to land on when flipping to Local from a cloud
	 *  selection — typically the smallest cached catalog model. Returning
	 *  ``null`` (e.g. an empty catalog) leaves the persisted model untouched.
	 *  Mirrors {@link defaultCloudModelId} for the Cloud direction so the toggle
	 *  is symmetric: each side lands on a usable model of its own kind. */
	pickLocalDefault: () => string | null;
	/** Currently-selected (persisted) model id. */
	selectedModel: string;
}

interface UseSttSourceSwitchResult {
	/** Cloud model id the cloud picker should display RIGHT NOW. Equals the
	 *  persisted model once it is a cloud id; during the flip-to-Cloud settings
	 *  round-trip (persisted model still local) it is the optimistic target the
	 *  switch just chose, so the trigger shows the default/last cloud model
	 *  immediately instead of an empty "Select cloud model" placeholder. */
	cloudSelectedId: string;
	onSourceChange: (next: SttSource) => void;
	source: SttSource;
	sourceOpts: SwitcherOption<SttSource>[];
}

/**
 * Shared Local/Cloud source-switch logic for the main STT model picker — used
 * by both the Settings → Transcription tab (`SourceArea`) and the detached
 * model-picker window so the toggle behaves identically in both surfaces.
 *
 * Owns only the "which picker is on screen" state plus the two invariants that
 * are easy to get subtly wrong (and that we don't want duplicated):
 *  - flipping to Cloud must leave a *valid* cloud model selected, or dictation
 *    silently keeps running the local model (see `feedback_capability_must_have_model`);
 *  - the Cloud option is locked behind a configured key, with a lock badge that
 *    routes the user to where they add one.
 *
 * Flipping source persists a model of the target kind so the toggle is
 * symmetric and the rest of the UI (the model controls, and the detached picker
 * the local trigger opens — which derives its own mode from the persisted
 * model) immediately reflects the chosen source. Flipping to Cloud lands on a
 * keyed provider's default; flipping to Local lands on {@link pickLocalDefault}.
 * A no-op (already the right kind, or no candidate) leaves settings untouched.
 */
export function useSttSourceSwitch({
	hasAnyCloudKey,
	initialSourceIsCloud,
	onConfigureCloud,
	onModelChange,
	pickLocalDefault,
	selectedModel,
}: UseSttSourceSwitchArgs): UseSttSourceSwitchResult {
	const t = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);
	// OpenRouter STT reuses the single LLM OpenRouter key, not an integrations entry.
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const [source, setSource] = useState<SttSource>(
		initialSourceIsCloud ? "cloud" : "local",
	);
	// Optimistic cloud target chosen on flip-to-Cloud, held only for the brief
	// window before the persisted model round-trips back as a cloud id (after
	// which `selectedModel` is authoritative and the host re-mounts).
	const [pendingCloudModel, setPendingCloudModel] = useState<string | null>(
		null,
	);

	// Persist the last cloud model the user actually settled on (whether picked
	// from the selector or resolved by the picker's self-heal) so a later flip
	// back to Cloud can restore it immediately.
	useEffect(() => {
		if (providerOf(selectedModel) !== null) {
			writeLastCloudModel(selectedModel);
		}
	}, [selectedModel]);

	const onSourceChange = (next: SttSource) => {
		const current = providerOf(selectedModel);
		if (next === "cloud") {
			setSource(next);
			const keyed = CLOUD_PROVIDERS.filter((p) =>
				p === "openrouter"
					? openrouterKey.trim().length > 0
					: integrations[p].apiKey.trim().length > 0,
			);
			const alreadyValid = current !== null && keyed.includes(current);
			if (alreadyValid || keyed[0] === undefined) {
				return;
			}
			// Prefer the last chosen cloud model when its provider is still keyed —
			// it's a concrete id, so the selector lands on it at once instead of
			// waiting for a live catalog scan to resolve a bare provider default.
			// Otherwise fall back to the first keyed provider's default.
			const lastCloud = readLastCloudModel();
			const lastCloudProvider =
				lastCloud === null ? null : providerOf(lastCloud);
			const canRestoreLast =
				lastCloud !== null &&
				lastCloudProvider !== null &&
				keyed.includes(lastCloudProvider);
			const target = canRestoreLast ? lastCloud : defaultCloudModelId(keyed[0]);
			// Show it immediately (before the settings round-trip) so the trigger
			// never flashes the empty placeholder.
			setPendingCloudModel(target);
			onModelChange(target);
			return;
		}
		// Flipping to Local: only act when leaving a cloud selection. Land on a
		// local default so the picker (and the detached window it opens) shows
		// local instead of staying stranded on the previous cloud model.
		if (current !== null) {
			const localDefault = pickLocalDefault();
			if (localDefault) {
				setSource(next);
				onModelChange(localDefault);
			}
			return;
		}
		setSource(next);
	};

	const sourceOpts: SwitcherOption<SttSource>[] = [
		{ value: "local", label: t("sourceLocal"), icon: AiComputerIcon },
		{
			value: "cloud",
			label: t("sourceCloud"),
			icon: CloudServerIcon,
			disabled: !hasAnyCloudKey,
			...(hasAnyCloudKey
				? {}
				: {
						badgeIcon: LockIcon,
						badgeTooltip: t("sourceCaption"),
						badgeTooltipFooter: t("cloudDisabledHint"),
						onBadgeClick: onConfigureCloud,
					}),
		},
	];

	// The persisted model wins once it is a cloud id; until then, fall back to the
	// optimistic target so the cloud picker shows a real model during the flip.
	const cloudSelectedId =
		providerOf(selectedModel) === null
			? (pendingCloudModel ?? "")
			: selectedModel;

	return { cloudSelectedId, onSourceChange, source, sourceOpts };
}

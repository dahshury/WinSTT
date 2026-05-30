import { AiCloud01Icon, CpuIcon, LockIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { CLOUD_PROVIDERS, defaultCloudModelId, providerOf } from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import type { SwitcherOption } from "@/shared/ui/switcher";

type SttSource = "local" | "cloud";

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
	onSourceChange: (next: SttSource) => void;
	source: SttSource;
	sourceOpts: SwitcherOption<SttSource>[];
}

/**
 * Shared Local/Cloud source-switch logic for the main STT model picker — used
 * by both the Settings → Models tab (`SourceArea`) and the detached
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
	const [source, setSource] = useState<SttSource>(initialSourceIsCloud ? "cloud" : "local");

	const onSourceChange = (next: SttSource) => {
		setSource(next);
		const current = providerOf(selectedModel);
		if (next === "cloud") {
			const keyed = CLOUD_PROVIDERS.filter((p) => integrations[p].apiKey.trim().length > 0);
			const alreadyValid = current !== null && keyed.includes(current);
			if (!alreadyValid && keyed[0] !== undefined) {
				onModelChange(defaultCloudModelId(keyed[0]));
			}
			return;
		}
		// Flipping to Local: only act when leaving a cloud selection. Land on a
		// local default so the picker (and the detached window it opens) shows
		// local instead of staying stranded on the previous cloud model.
		if (current !== null) {
			const localDefault = pickLocalDefault();
			if (localDefault) {
				onModelChange(localDefault);
			}
		}
	};

	const sourceOpts: SwitcherOption<SttSource>[] = [
		{ value: "local", label: t("sourceLocal"), icon: CpuIcon },
		{
			value: "cloud",
			label: t("sourceCloud"),
			icon: AiCloud01Icon,
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

	return { onSourceChange, source, sourceOpts };
}

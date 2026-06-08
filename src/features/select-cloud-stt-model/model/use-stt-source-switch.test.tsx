import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { useSttSourceSwitch } from "./use-stt-source-switch";

const initialSettings = useSettingsStore.getState().settings;

// ElevenLabs is the only integrations-backed cloud STT provider; OpenRouter STT
// reuses the single LLM key (`settings.llm.openrouterApiKey`), not an
// integrations entry (OpenAI was removed as a direct cloud STT provider).
function setKeys(elevenlabs: string, openrouter: string): void {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			integrations: {
				elevenlabs: {
					apiKey: elevenlabs,
					verified: null,
					lastVerifiedAt: null,
				},
			},
			llm: { ...initialSettings.llm, openrouterApiKey: openrouter },
		},
	});
}

afterEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
});

interface Args {
	hasAnyCloudKey: boolean;
	initialSourceIsCloud: boolean;
	onConfigureCloud: () => void;
	onModelChange: (modelId: string) => void;
	pickLocalDefault: () => string | null;
	selectedModel: string;
}

function renderSwitch(args: Partial<Args> = {}) {
	const onModelChange =
		args.onModelChange ?? mock<(id: string) => void>(() => undefined);
	const onConfigureCloud =
		args.onConfigureCloud ?? mock<() => void>(() => undefined);
	const pickLocalDefault =
		args.pickLocalDefault ?? mock<() => string | null>(() => "tiny");
	const result = renderHook(
		() =>
			useSttSourceSwitch({
				hasAnyCloudKey: args.hasAnyCloudKey ?? true,
				initialSourceIsCloud: args.initialSourceIsCloud ?? false,
				onConfigureCloud,
				onModelChange,
				pickLocalDefault,
				selectedModel: args.selectedModel ?? "tiny",
			}),
		{ wrapper: IntlProvider },
	);
	return { ...result, onConfigureCloud, onModelChange, pickLocalDefault };
}

describe("useSttSourceSwitch", () => {
	test("initialises source from initialSourceIsCloud", () => {
		setKeys("el-key", "");
		const local = renderSwitch({ initialSourceIsCloud: false });
		expect(local.result.current.source).toBe("local");
		const cloud = renderSwitch({ initialSourceIsCloud: true });
		expect(cloud.result.current.source).toBe("cloud");
	});

	test("locks the Cloud option (disabled + lock badge) when no key is configured", () => {
		setKeys("", "");
		const { result } = renderSwitch({ hasAnyCloudKey: false });
		const cloudOpt = result.current.sourceOpts.find((o) => o.value === "cloud");
		expect(cloudOpt?.disabled).toBe(true);
		expect(cloudOpt?.badgeIcon).toBeDefined();
		expect(cloudOpt?.onBadgeClick).toBeDefined();
	});

	test("enables the Cloud option with no badge once a key exists", () => {
		setKeys("el-key", "");
		const { result } = renderSwitch({ hasAnyCloudKey: true });
		const cloudOpt = result.current.sourceOpts.find((o) => o.value === "cloud");
		expect(cloudOpt?.disabled).toBe(false);
		expect(cloudOpt?.badgeIcon).toBeUndefined();
	});

	test("flipping to Cloud from a local model auto-picks the first keyed provider's default", () => {
		// Only ElevenLabs keyed → the auto-pick lands on its default model.
		setKeys("sk-eleven", "");
		const { result, onModelChange } = renderSwitch({
			selectedModel: "tiny",
			initialSourceIsCloud: false,
		});
		act(() => result.current.onSourceChange("cloud"));
		expect(onModelChange).toHaveBeenCalledTimes(1);
		expect(onModelChange).toHaveBeenCalledWith("elevenlabs:scribe_v1");
		expect(result.current.source).toBe("cloud");
	});

	test("flipping to Cloud does NOT clobber an already-valid keyed cloud selection", () => {
		setKeys("sk-eleven", "");
		const { result, onModelChange } = renderSwitch({
			selectedModel: "elevenlabs:scribe_v1",
			initialSourceIsCloud: true,
		});
		act(() => result.current.onSourceChange("cloud"));
		expect(onModelChange).not.toHaveBeenCalled();
	});

	test("flipping to Cloud re-picks when the persisted cloud model's provider has no key", () => {
		// Persisted OpenRouter model but only ElevenLabs keyed → not valid, re-pick ElevenLabs.
		setKeys("sk-eleven", "");
		const { result, onModelChange } = renderSwitch({
			selectedModel: "openrouter:openai/whisper-1",
			initialSourceIsCloud: false,
		});
		act(() => result.current.onSourceChange("cloud"));
		expect(onModelChange).toHaveBeenCalledWith("elevenlabs:scribe_v1");
	});

	test("flipping to Local from a cloud model lands on the local default", () => {
		// Symmetric with the Cloud direction: leaving a cloud selection must pick a
		// local model so the picker (and the detached window it opens) shows local
		// instead of staying stranded on the previous cloud id.
		setKeys("sk-eleven", "");
		const pickLocalDefault = mock<() => string | null>(() => "base");
		const { result, onModelChange } = renderSwitch({
			selectedModel: "elevenlabs:scribe_v1",
			initialSourceIsCloud: true,
			pickLocalDefault,
		});
		act(() => result.current.onSourceChange("local"));
		expect(onModelChange).toHaveBeenCalledWith("base");
		expect(result.current.source).toBe("local");
	});

	test("flipping to Local from a local model is a no-op", () => {
		setKeys("sk-eleven", "");
		const { result, onModelChange } = renderSwitch({
			selectedModel: "tiny",
			initialSourceIsCloud: false,
		});
		act(() => result.current.onSourceChange("local"));
		expect(onModelChange).not.toHaveBeenCalled();
		expect(result.current.source).toBe("local");
	});

	test("flipping to Local leaves source and model untouched when there is no cached local candidate", () => {
		setKeys("sk-eleven", "");
		const pickLocalDefault = mock<() => string | null>(() => null);
		const { result, onModelChange } = renderSwitch({
			selectedModel: "elevenlabs:scribe_v1",
			initialSourceIsCloud: true,
			pickLocalDefault,
		});
		act(() => result.current.onSourceChange("local"));
		expect(onModelChange).not.toHaveBeenCalled();
		expect(result.current.source).toBe("cloud");
	});
});

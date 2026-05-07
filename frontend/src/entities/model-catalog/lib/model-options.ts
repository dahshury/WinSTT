import type { SelectOption } from "@/shared/ui/select";
import type { ModelInfo } from "../model/catalog-store";

const FAMILY_LABELS: Record<string, string> = {
	whisper: "Whisper",
	nemo: "NeMo",
	gigaam: "GigaAM",
	kaldi: "Kaldi",
	"t-one": "T-One",
};

/** Build grouped select options from a model catalog, prefixed by family label. */
export function buildModelOpts(models: readonly ModelInfo[]): SelectOption[] {
	const grouped = new Map<string, ModelInfo[]>();
	for (const m of models) {
		const list = grouped.get(m.family) ?? [];
		list.push(m);
		grouped.set(m.family, list);
	}
	const opts: SelectOption[] = [];
	for (const [family, items] of grouped) {
		const familyLabel = FAMILY_LABELS[family] ?? family;
		for (const m of items) {
			opts.push({
				id: m.id,
				label: `[${familyLabel}] ${m.displayName} (${m.sizeLabel})`,
			});
		}
	}
	return opts;
}

/** Build select options filtered to models that support realtime transcription. */
export function buildRealtimeOpts(models: readonly ModelInfo[]): SelectOption[] {
	return buildModelOpts(models.filter((m) => m.supportsRealtime));
}

import {
	AiMicIcon,
	Analytics01Icon,
	Coins01Icon,
	Tag01Icon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { type ModelInfo, useCatalogStore } from "@/entities/model-catalog";
import { SettingSection } from "@/entities/setting";
import { publicAsset } from "@/shared/lib/public-asset";
import {
	makerFromModelId,
	resolveProviderIcon,
} from "@/shared/lib/provider-icons";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
// Deep-import the lightweight family logo/maker resolvers (NOT the heavy
// `@/widgets/model-picker` barrel) so the settings chunk stays lean — same guard
// `useRuntimeModelBreakdown` uses.
import {
	getAuthorLabel,
	getFamilyConfig,
} from "@/widgets/model-picker/stt/lib/family-helpers";
import { useHistoryStats } from "../api/use-history-stats";
import { computeAuthorUsage, type ResolvedAuthor } from "../lib/author-usage";
import { computeCostAnalytics, type ResolveMaker } from "../lib/cost-analytics";
import { computeStreak } from "../lib/streak";
import { computeUsage } from "../lib/usage-breakdown";
import { CATEGORY_ICONS, MODEL_ICONS } from "../lib/usage-icons";
import { buildHeatmap } from "../lib/word-stats";
import type {
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "../model/history-store";
import { ContributionGraph } from "./ContributionGraph";
import { DateRangeFilter } from "./DateRangeFilter";
import { HistoryHero } from "./HistoryHero";
import { ModelAuthorRadar } from "./ModelAuthorRadar";
import { SpendingSection } from "./SpendingSection";
import { StreakBanner } from "./StreakBanner";
import { UsageBars } from "./UsageBreakdown";
import { VoiceProfile } from "./VoiceProfile";

/**
 * Build a `sttModel` → maker+logo resolver from the STT catalog. History stores
 * the loaded model's id (or, for older rows, its display name), so we key on
 * both. Unknown strings resolve to `null` and land in the pie's "Other" slice.
 */
function buildAuthorResolver(
	models: ModelInfo[],
): (sttModel: string) => ResolvedAuthor | null {
	const familyByKey = new Map<string, ModelInfo["family"]>();
	for (const model of models) {
		familyByKey.set(model.id.toLowerCase(), model.family);
		familyByKey.set(model.displayName.toLowerCase(), model.family);
	}
	return (sttModel) => {
		const family = familyByKey.get(sttModel.toLowerCase().trim());
		if (!family) {
			return null;
		}
		const logoSrc = getFamilyConfig(family).logoSrc;
		return {
			author: getAuthorLabel(family),
			logoSrc: logoSrc ? publicAsset(logoSrc) : null,
		};
	};
}

const ELEVENLABS_LABEL = "ElevenLabs";

// Proper casing for the common cost makers; anything else title-cases its raw
// vendor token. Keeps the cost-by-maker radar's labels tidy without needing a
// catalog entry (LLM and TTS makers aren't in the STT catalog).
const MAKER_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	cohere: "Cohere",
	deepseek: "DeepSeek",
	elevenlabs: ELEVENLABS_LABEL,
	google: "Google",
	hexgrad: "Kokoro",
	"meta-llama": "Meta",
	microsoft: "Microsoft",
	mistralai: "Mistral",
	openai: "OpenAI",
	qwen: "Qwen",
	"x-ai": "xAI",
};

function makerLabel(token: string): string {
	return (
		MAKER_LABELS[token] ??
		(token.length > 0 ? token.charAt(0).toUpperCase() + token.slice(1) : token)
	);
}

/**
 * Resolve ANY stored model id (cloud STT/TTS `provider:model`, or a bare
 * OpenRouter LLM id) to its maker + brand logo for the cost-by-maker radar.
 * Unlike {@link buildAuthorResolver} (STT-catalog only), this keys off the raw
 * vendor token so LLM and TTS makers resolve too; unknown tokens return `null`
 * and fold into the radar's "Other" spoke.
 */
function buildCostMakerResolver(): ResolveMaker {
	return (modelId) => {
		if (modelId.startsWith("elevenlabs:")) {
			return {
				author: ELEVENLABS_LABEL,
				logoSrc: resolveProviderIcon("elevenlabs"),
			};
		}
		const bare = modelId.replace(/^openrouter:/, "");
		const token = makerFromModelId(bare);
		if (!token) {
			return null;
		}
		return { author: makerLabel(token), logoSrc: resolveProviderIcon(token) };
	};
}

/**
 * Placeholder grid shown while the worker computes the hero / voice-profile
 * stats on a cold open. Mirrors the real grids' columns so the layout doesn't
 * shift when the numbers arrive.
 */
function StatsSkeleton({
	className,
	count,
	itemClassName,
}: {
	className: string;
	count: number;
	itemClassName: string;
}) {
	return (
		<div aria-hidden className={className}>
			{Array.from({ length: count }, (_, i) => (
				<div
					className={`animate-pulse rounded-lg bg-surface-elevated ${itemClassName}`}
					key={i}
				/>
			))}
		</div>
	);
}

const recentDailyWordsCache = new WeakMap<object, number[]>();

function recentDailyWords(entries: ReturnType<typeof buildHeatmap>): number[] {
	const cached = recentDailyWordsCache.get(entries);
	if (cached) {
		return cached;
	}
	const words = entries.slice(-30).map((b) => b.wordCount);
	recentDailyWordsCache.set(entries, words);
	return words;
}

interface HistoryDashboardSectionsProps {
	/** Full history (unfiltered) — habit views and the recent-activity sparkline
	 *  read all-time data rather than the selected window. */
	entries: TranscriptionHistoryEntry[];
	/** Date-filtered transcription entries — every windowed stat reads these. */
	filteredEntries: TranscriptionHistoryEntry[];
	/** Date-filtered read-aloud runs, for the cloud-spend analytics. */
	filteredTtsEntries: TtsHistoryEntry[];
	onRangeChange: (range: DateRange | null) => void;
	selectedRange: DateRange | null;
}

/**
 * The History panel's read-only analytics dashboard: the summary hero (with the
 * date-range filter in its header), the voice profile + all-time habit pulse,
 * the model/category usage breakdowns, and the cloud-spend analytics. Every
 * windowed section reads the date-filtered entries the parent passes down, so
 * the calendar picker scopes them all.
 */
export function HistoryDashboardSections({
	entries,
	filteredEntries,
	filteredTtsEntries,
	onRangeChange,
	selectedRange,
}: HistoryDashboardSectionsProps) {
	const t = useTranslations("history");
	// The two diff/tokenize-heavy stats are computed off the main thread; the
	// rest below are cheap O(n) passes kept inline. `statsLoading` is true only
	// on the first compute (cold cache), so revisits with warm data render
	// immediately without a skeleton flash.
	const {
		stats,
		voiceProfile,
		loading: statsLoading,
	} = useHistoryStats(filteredEntries);
	const usageOtherLabel = t("usageOther");
	const usage = computeUsage(filteredEntries, usageOtherLabel);
	// Group the same filtered history by model maker for the pie beside the
	// model bars. The catalog self-hydrates on import, so it's populated here.
	const catalogModels = useCatalogStore((s) => s.models);
	const authorResolver = buildAuthorResolver(catalogModels);
	const authorSlices = computeAuthorUsage(
		filteredEntries,
		authorResolver,
		usageOtherLabel,
	);
	// Give the model bars the SAME catalog-family logo the radar uses, so local
	// makers (NeMo → NVIDIA, GigaAM → Sber, Whisper → OpenAI, …) show their brand
	// mark. The `modelChipLogo` baked into each bucket only resolves ids that
	// carry a vendor token (cloud `openrouter:cohere/…` etc.), so it stays as the
	// fallback for runtime-scanned OpenRouter models the catalog doesn't list.
	const modelBuckets = usage.models.map((bucket) => ({
		...bucket,
		logo: authorResolver(bucket.key)?.logoSrc ?? bucket.logo ?? null,
	}));
	// Cloud-spend analytics over the SAME date-filtered window (STT + TTS runs).
	// `total === 0` for local-only histories, which hides the whole section.
	const costAnalytics = computeCostAnalytics(
		filteredEntries,
		filteredTtsEntries,
		buildCostMakerResolver(),
		{
			languageModel: t("costLanguageModel"),
			other: usageOtherLabel,
			speechToText: t("costSpeechToText"),
			textToSpeech: t("costTextToSpeech"),
		},
	);
	// Streak and the year-long contribution graph are all-time habit views, so
	// they read the full history rather than the selected date range.
	const streak = computeStreak(entries);
	// Recent 30-day word trend for the hero sparkline — a stable "recent
	// activity" signal independent of the selected range, so filtering to a past
	// window doesn't blank it out.
	const dailyWords = recentDailyWords(buildHeatmap(entries));

	return (
		<>
			{/* Everything from here down follows the date-range filter in this
			    section's header. The interactive calendar lives inside that
			    popover chip — it's a filter control, not a dashboard view. */}
			<SettingSection
				headerAction={
					<DateRangeFilter
						entries={entries}
						onRangeChange={onRangeChange}
						selectedRange={selectedRange}
					/>
				}
				icon={Analytics01Icon}
				title={t("summaryTitle")}
			>
				<div className="py-2">
					{statsLoading ? (
						<StatsSkeleton
							className="grid grid-cols-3 gap-2"
							count={3}
							itemClassName="h-[132px]"
						/>
					) : (
						<HistoryHero dailyWords={dailyWords} stats={stats} />
					)}
				</div>
			</SettingSection>

			<SettingSection icon={VoiceIdIcon} title={t("profileTitle")}>
				<div className="flex flex-col gap-4 py-2">
					{statsLoading ? (
						<StatsSkeleton
							className="grid grid-cols-2 gap-2"
							count={4}
							itemClassName="h-16"
						/>
					) : (
						<VoiceProfile stats={voiceProfile} />
					)}
					{/* All-time habit pulse: streak + year-long contribution graph.
					    Unlike the profile stats above (which follow the date-range
					    filter), this pair deliberately reads the full history — it
					    answers "am I keeping the habit up", not "what happened in
					    this window". */}
					<div className="flex flex-col gap-4 border-border border-t pt-4">
						<StreakBanner streak={streak} />
						<ContributionGraph entries={entries} />
					</div>
				</div>
			</SettingSection>

			{usage.models.length > 0 ? (
				<SettingSection icon={AiMicIcon} title={t("usageModelsTitle")}>
					<div className="flex flex-col gap-5 py-2 sm:flex-row sm:items-center sm:gap-6">
						<div className="min-w-0 flex-1">
							<UsageBars buckets={modelBuckets} icons={MODEL_ICONS} />
						</div>
						<ModelAuthorRadar slices={authorSlices} />
					</div>
				</SettingSection>
			) : null}

			{usage.categories.length > 0 ? (
				<SettingSection icon={Tag01Icon} title={t("usageCategoriesTitle")}>
					<div className="py-2">
						<UsageBars buckets={usage.categories} icons={CATEGORY_ICONS} />
					</div>
				</SettingSection>
			) : null}

			{/* Cloud-spend analytics — only when the filtered window has cloud
			    cost (local-only histories skip it entirely). Scoped by the same
			    calendar picker as every section above. */}
			{costAnalytics.total > 0 ? (
				<SettingSection icon={Coins01Icon} title={t("spendingTitle")}>
					<SpendingSection analytics={costAnalytics} />
				</SettingSection>
			) : null}
		</>
	);
}

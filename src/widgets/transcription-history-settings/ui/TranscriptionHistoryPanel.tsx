import {
	AiMicIcon,
	Analytics01Icon,
	CalendarAnalysisIcon,
	CalendarClockIcon,
	CalendarDaysIcon,
	CalendarRangeIcon,
	DatabaseSettingIcon,
	Delete02Icon,
	InfinityIcon,
	ListViewIcon,
	Tag01Icon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	type ModelInfo,
	useCatalogStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	clearTranscriptionHistory,
	clearTransformHistory,
} from "@/shared/api/ipc-client";
import { publicAsset } from "@/shared/lib/public-asset";
import { Button } from "@/shared/ui/button";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
// Deep-import the lightweight family logo/maker resolvers (NOT the heavy
// `@/widgets/model-picker` barrel) so the settings chunk stays lean — same guard
// `useRuntimeModelBreakdown` uses.
import {
	getAuthorLabel,
	getFamilyConfig,
} from "@/widgets/model-picker/stt/lib/family-helpers";
import { useHistoryStats } from "../api/use-history-stats";
import {
	computeAuthorUsage,
	type ResolvedAuthor,
} from "../lib/author-usage";
import { computeStreak } from "../lib/streak";
import { computeUsage } from "../lib/usage-breakdown";
import { buildHeatmap, filterEntriesByDateRange } from "../lib/word-stats";
import { useTranscriptionHistoryStore } from "../model/history-store";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { ContributionGraph } from "./ContributionGraph";
import { HistoryHero } from "./HistoryHero";
import { HistoryTable } from "./HistoryTable";
import { ModelAuthorRadar } from "./ModelAuthorRadar";
import { StreakBanner } from "./StreakBanner";
import { CATEGORY_ICONS, UsageBars } from "./UsageBreakdown";
import { VoiceProfile } from "./VoiceProfile";

type RetentionValue = "never" | "cap" | "days3" | "weeks2" | "months3";

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
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static placeholder
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

export function TranscriptionHistoryPanel() {
	const t = useTranslations("history");
	// History data is hydrated + kept live at the settings-window root
	// (SettingsBootstrap → useTranscriptionHistorySync), so this panel is a pure
	// reader: on every tab revisit the entries array keeps its identity and the
	// stats caches stay warm.
	const entries = useTranscriptionHistoryStore((s) => s.entries);
	const transformEntries = useTranscriptionHistoryStore(
		(s) => s.transformEntries,
	);
	const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
	const clearTransformLocal = useTranscriptionHistoryStore(
		(s) => s.clearTransforms,
	);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [confirmTransformsOpen, setConfirmTransformsOpen] = useState(false);
	const [selectedRange, setSelectedRange] = useState<DateRange | null>(null);
	const historyMaxEntries = useSettingsStore(
		(s) => s.settings.general?.historyMaxEntries ?? 1000,
	);
	const recordingRetention = useSettingsStore(
		(s) =>
			(s.settings.general?.recordingRetention as RetentionValue | undefined) ??
			"cap",
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const retentionOptions: SelectOption[] = [
		{ id: "never", label: t("retentionNever"), icon: InfinityIcon },
		{ id: "cap", label: t("retentionCap"), icon: ListViewIcon },
		{ id: "days3", label: t("retentionDays3"), icon: CalendarDaysIcon },
		{ id: "weeks2", label: t("retentionWeeks2"), icon: CalendarRangeIcon },
		{ id: "months3", label: t("retentionMonths3"), icon: CalendarClockIcon },
	];

	const filteredEntries = filterEntriesByDateRange(
		entries,
		selectedRange?.from ?? null,
		selectedRange?.to ?? null,
	);
	const filteredTransformEntries = filterEntriesByDateRange(
		transformEntries,
		selectedRange?.from ?? null,
		selectedRange?.to ?? null,
	);
	const combinedHistoryEntries = [
		...filteredEntries.map((entry) => ({
			entry,
			kind: "transcription" as const,
		})),
		...filteredTransformEntries.map((entry) => ({
			entry,
			kind: "transform" as const,
		})),
	];
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
	const authorSlices = computeAuthorUsage(
		filteredEntries,
		buildAuthorResolver(catalogModels),
		usageOtherLabel,
	);
	// Streak and the year-long contribution graph are all-time habit views, so
	// they read the full history rather than the selected date range.
	const streak = computeStreak(entries);
	// Recent 30-day word trend for the hero sparkline — a stable "recent
	// activity" signal independent of the selected range, so filtering to a past
	// window doesn't blank it out.
	const dailyWords = recentDailyWords(buildHeatmap(entries));

	const handleClear = () => {
		clearTranscriptionHistory().then(() => clearLocal());
	};

	const handleClearTransforms = () => {
		clearTransformHistory().then(() => clearTransformLocal());
	};

	return (
		<div className="flex flex-col">
			<SettingSection icon={Analytics01Icon} title={t("summaryTitle")}>
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

			{usage.models.length > 0 ? (
				<SettingSection icon={AiMicIcon} title={t("usageModelsTitle")}>
					<div className="flex flex-col gap-5 py-2 sm:flex-row sm:items-center sm:gap-6">
						<div className="min-w-0 flex-1">
							<UsageBars buckets={usage.models} />
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

			<SettingSection icon={CalendarAnalysisIcon} title={t("heatmapTitle")}>
				<div className="flex flex-col gap-4 py-2">
					<StreakBanner streak={streak} />
					<ContributionGraph entries={entries} />
					<ActivityHeatmap
						entries={entries}
						onRangeChange={setSelectedRange}
						selectedRange={selectedRange}
					/>
				</div>
			</SettingSection>

			<SettingSection icon={VoiceIdIcon} title={t("profileTitle")}>
				<div className="py-2">
					{statsLoading ? (
						<StatsSkeleton
							className="grid grid-cols-2 gap-2"
							count={4}
							itemClassName="h-16"
						/>
					) : (
						<VoiceProfile stats={voiceProfile} />
					)}
				</div>
			</SettingSection>

			<SettingSection
				headerAction={
					<div className="flex flex-wrap items-center justify-end gap-1.5">
						<ConfirmDialog
							confirmLabel={t("clearConfirm")}
							description={t("clearDescription")}
							onConfirm={handleClear}
							onOpenChange={setConfirmOpen}
							open={confirmOpen}
							title={t("clearTitle")}
						/>
						<Button
							className="flex items-center gap-1.5 bg-surface-elevated px-3 py-1.5 text-foreground-secondary text-xs-tight hover:bg-error hover:text-on-error disabled:opacity-50"
							disabled={entries.length === 0}
							onClick={() => setConfirmOpen(true)}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
							{t("clearButton")}
						</Button>
						<ConfirmDialog
							confirmLabel={t("clearConfirm")}
							description={t("clearTransformsDescription")}
							onConfirm={handleClearTransforms}
							onOpenChange={setConfirmTransformsOpen}
							open={confirmTransformsOpen}
							title={t("clearTransformsTitle")}
						/>
						<Button
							className="flex items-center gap-1.5 bg-surface-elevated px-3 py-1.5 text-foreground-secondary text-xs-tight hover:bg-error hover:text-on-error disabled:opacity-50"
							disabled={transformEntries.length === 0}
							onClick={() => setConfirmTransformsOpen(true)}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
							{t("clearTransformsButton")}
						</Button>
					</div>
				}
				boxed
				icon={ListViewIcon}
				title={`${t("tableTitle")} / ${t("transformTableTitle")}`}
			>
				<div className="py-2">
					<HistoryTable entries={combinedHistoryEntries} />
				</div>
			</SettingSection>

			{/* Limits — history-entry cap and saved-recording retention.
			    Cap defaults to 1000, retention defaults to "cap" (delete
			    only when the entry count exceeds the cap; absolute time
			    cutoffs are opt-in). */}
			<SettingSection
				boxed
				divided
				icon={DatabaseSettingIcon}
				title={t("limitsTitle")}
			>
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.historyMaxEntries}
					label={t("historyMaxEntries")}
					layout="row"
					onReset={() =>
						updateGeneral({
							historyMaxEntries: DEFAULT_SETTINGS.general.historyMaxEntries,
						})
					}
					tooltip={`${t("historyMaxEntriesTooltip")} ${t("historyMaxEntriesCaption")}`}
					value={historyMaxEntries}
				>
					<NumberStepper
						max={10_000}
						min={10}
						onChange={(v) => updateGeneral({ historyMaxEntries: v })}
						step={10}
						value={historyMaxEntries}
					/>
				</SettingField>
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.recordingRetention}
					label={t("retention")}
					layout="row"
					onReset={() =>
						updateGeneral({
							recordingRetention: DEFAULT_SETTINGS.general.recordingRetention,
						})
					}
					tooltip={t("retentionTooltip")}
					value={recordingRetention}
				>
					<Select
						className="w-52"
						onChange={(v) =>
							updateGeneral({ recordingRetention: v as RetentionValue })
						}
						options={retentionOptions}
						value={recordingRetention}
					/>
				</SettingField>
			</SettingSection>
		</div>
	);
}

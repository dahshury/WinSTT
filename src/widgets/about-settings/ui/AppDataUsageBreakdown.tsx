import {
	AiChat02Icon,
	AiMicIcon,
	AiVoiceGeneratorIcon,
	Books02Icon,
	Calendar03Icon,
	Delete02Icon,
	File01Icon,
	Folder01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import type { AppDataUsageEntry } from "@/bindings";
import { commands } from "@/bindings";
import { appDataUsage, removeAppDataCategory } from "@/shared/api/ipc-client";
import type { SettingsTranslateFn } from "@/shared/i18n/translation-types";
import { formatBytes } from "@/shared/lib/format-bytes";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

/** Category glyphs reuse the model-footprint / settings vocabulary so the
 *  storage view reads with the same language as the rest of the app. */
const CATEGORY_ICON = {
	stt: AiChat02Icon,
	tts: AiVoiceGeneratorIcon,
	dictionary: Books02Icon,
	wakeword: AiMicIcon,
	history: Calendar03Icon,
	logs: File01Icon,
	other: Folder01Icon,
} as const satisfies Record<string, typeof AiChat02Icon>;

const CATEGORY_LABEL = {
	stt: "appDataUsageStt",
	tts: "appDataUsageTts",
	dictionary: "appDataUsageDictionary",
	wakeword: "appDataUsageWakeword",
	history: "appDataUsageHistory",
	logs: "appDataUsageLogs",
	other: "appDataUsageOther",
} as const satisfies Record<string, string>;

type CategoryKey = keyof typeof CATEGORY_ICON;

// "Other" is settings + misc cache — removing it would reset the app, so it has
// no per-row trash (the Rust command rejects it too). Use "Reset to defaults".
function isRemovable(key: string): boolean {
	return key !== "other" && key in CATEGORY_ICON;
}

function sizeText(bytes: number): string {
	return (
		formatBytes(bytes, {
			minUnit: "KB",
			gbDecimals: 1,
			mbDecimals: 0,
			kbDecimals: 0,
		}) ?? "0 KB"
	);
}

function categoryLabel(key: string, t: SettingsTranslateFn): string {
	return key in CATEGORY_LABEL ? t(CATEGORY_LABEL[key as CategoryKey]) : key;
}

function refetchAppDataUsage(
	mounted: { current: boolean },
	setEntries: (entries: AppDataUsageEntry[]) => void,
): void {
	appDataUsage()
		.then((data) => {
			if (mounted.current) {
				setEntries(data);
			}
		})
		.catch(() => {
			if (mounted.current) {
				setEntries([]);
			}
		});
}

function UsageRow({
	entry,
	total,
	t,
	onRemove,
}: {
	entry: AppDataUsageEntry;
	total: number;
	t: SettingsTranslateFn;
	onRemove: (entry: AppDataUsageEntry) => void;
}): ReactNode {
	const known = entry.key in CATEGORY_ICON;
	const percent = total > 0 ? Math.round((entry.bytes / total) * 100) : 0;
	const label = categoryLabel(entry.key, t);
	return (
		<div className="flex items-center gap-3">
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-muted"
				disableSecondaryOpacity={true}
				icon={known ? CATEGORY_ICON[entry.key as CategoryKey] : Folder01Icon}
				size={16}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex items-baseline justify-between gap-2">
					<span className="truncate text-body-sm text-foreground">{label}</span>
					<span className="shrink-0 text-body-sm text-foreground-secondary tabular-nums">
						{sizeText(entry.bytes)}
						<span className="ml-1.5 text-foreground-muted">{percent}%</span>
					</span>
				</div>
				<div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
					<div
						className="h-full rounded-full bg-gradient-to-r from-foreground/25 to-foreground/40"
						style={{ width: `${percent}%` }}
					/>
				</div>
			</div>
			{isRemovable(entry.key) ? (
				<button
					aria-label={t("appDataUsageRemoveAria", { item: label })}
					className="-mr-1 shrink-0 cursor-pointer rounded-xs p-1 text-foreground-muted outline-none transition-colors hover:text-error focus-visible:ring-1 focus-visible:ring-accent"
					onClick={() => onRemove(entry)}
					title={t("appDataUsageRemoveAria", { item: label })}
					type="button"
				>
					<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={15} />
				</button>
			) : null}
		</div>
	);
}

/**
 * A read-only disk-usage distribution shown in the About tab above the removal
 * actions, with a per-row trash that frees just that category — so the user can
 * see *and* clear what each thing costs. Sibling of the model-footprint
 * breakdown, applied to on-disk app data.
 */
export function AppDataUsageBreakdown(): ReactNode {
	const t = useTranslations("settings");
	const tc = useTranslations("common");
	const [entries, setEntries] = useState<AppDataUsageEntry[] | null>(null);
	const [pending, setPending] = useState<AppDataUsageEntry | null>(null);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		refetchAppDataUsage(mounted, setEntries);
		return () => {
			mounted.current = false;
		};
	}, []);

	const handleConfirm = async () => {
		const key = pending?.key;
		setPending(null);
		if (!key) {
			return;
		}
		try {
			// History is cleared via its own command (deletes rows + their WAVs);
			// every other category goes through the per-category cleanup command.
			if (key === "history") {
				await commands.historyClear();
			} else {
				await removeAppDataCategory(key);
			}
		} catch {
			// Best-effort: the refetch below reflects whatever was actually freed.
		}
		refetchAppDataUsage(mounted, setEntries);
	};

	const all = entries ?? [];
	const total = all.reduce((acc, e) => acc + e.bytes, 0);
	const rows = all.filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes);

	// Still loading, or nothing on disk yet — render nothing rather than an empty
	// shell (the removal buttons below already convey the section's purpose).
	if (entries === null || total <= 0) {
		return null;
	}

	const pendingLabel = pending ? categoryLabel(pending.key, t) : "";

	return (
		<>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={t("appDataUsageRemove")}
				description={
					<div className="flex flex-col gap-2">
						<p>
							{t("appDataUsageRemoveDescription", {
								item: pendingLabel,
								size: pending ? sizeText(pending.bytes) : "",
							})}
						</p>
						<p className="font-medium text-error">
							{t("permanentActionWarning")}
						</p>
					</div>
				}
				onConfirm={handleConfirm}
				onOpenChange={(open) => {
					if (!open) {
						setPending(null);
					}
				}}
				open={pending !== null}
				title={t("appDataUsageRemoveTitle", { item: pendingLabel })}
			/>
			<div className="flex flex-col gap-3 rounded-md border border-divider bg-foreground/5 p-3">
				<div className="flex items-baseline justify-between gap-2">
					<span className="font-medium text-body-sm text-foreground">
						{t("appDataUsageTitle")}
					</span>
					<span className="shrink-0 text-body-sm text-foreground-secondary tabular-nums">
						{sizeText(total)}
					</span>
				</div>
				<div className="flex flex-col gap-2.5">
					{rows.map((entry) => (
						<UsageRow
							entry={entry}
							key={entry.key}
							onRemove={setPending}
							t={t}
							total={total}
						/>
					))}
				</div>
			</div>
		</>
	);
}

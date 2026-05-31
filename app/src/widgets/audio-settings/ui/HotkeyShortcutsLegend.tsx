import { ArrowRight01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { RECORDING_MODE_COLOR_HEX, type RecordingMode } from "@/shared/config/recording-mode-color";
import { formatKeyName } from "@/shared/lib/format-key-name";

/**
 * Visual legend for the two hotkey combos detected in
 * `electron/ipc/hotkey.ts` while the global hotkey is held:
 *
 *   ┌── While the hotkey is held ────────────────────────────────────┐
 *   │                                                                │
 *   │  [hotkey] + [↑]   Cycle mode                                   │
 *   │  ┌─────┐ → ┌──────┐ → ┌──────┐ → ┌──────┐  ↻                  │
 *   │  │ PTT │   │TOGGLE│   │LISTEN│   │ WAKE │                     │
 *   │  └─────┘   └──────┘   └──────┘   └──────┘                     │
 *   │                                                                │
 *   │  [hotkey] + [⌫]   Cancel transcription                         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The mode chain reads left-to-right as the actual `MODE_CYCLE` order in
 * `electron/main.ts` (ptt → toggle → listen → wakeword → ptt). The
 * currently-active mode glows in its accent color (see
 * `RECORDING_MODE_COLOR_HEX`) so the legend doubles as a "you are here"
 * indicator — same palette the tray icon, settings switcher, and
 * recording pill use, so the legend reads as part of one system.
 *
 * Pure display surface: no interactive controls. The work happens in the
 * global hotkey listener; this just teaches the user what's possible.
 */

const MODE_CYCLE_ORDER: readonly RecordingMode[] = ["ptt", "toggle", "listen", "wakeword"] as const;

type ModeLabelKey = "shortcutPtt" | "shortcutToggle" | "shortcutListen" | "shortcutWakeword";

const MODE_LABEL_KEY: Record<RecordingMode, ModeLabelKey> = {
	ptt: "shortcutPtt",
	toggle: "shortcutToggle",
	listen: "shortcutListen",
	wakeword: "shortcutWakeword",
};

interface KeycapProps {
	children: React.ReactNode;
	emphasized?: boolean;
}

/**
 * Physical-feel keycap. The double-shadow (inset highlight on top,
 * inset deep-shadow on bottom, outer drop) is the same recipe the
 * recording-pill and ElevatedSurface use, so this slots in beside the
 * rest of the panel as one material system.
 */
function Keycap({ children, emphasized = false }: KeycapProps) {
	return (
		<span
			className={`inline-flex min-w-[1.6rem] items-center justify-center rounded-md px-1.5 py-0.5 font-mono text-[11px] leading-none tracking-tight ${
				emphasized
					? "bg-surface-5 text-foreground ring-1 ring-white/10"
					: "bg-surface-3 text-foreground-secondary ring-1 ring-white/[0.06]"
			} shadow-[inset_0_1px_0_0_rgba(255,255,255,0.10),inset_0_-1px_0_0_rgba(0,0,0,0.45),0_1px_2px_-0.5px_rgba(0,0,0,0.55)]`}
		>
			{children}
		</span>
	);
}

interface HotkeyPrefixProps {
	keys: readonly string[];
	placeholder: string;
	secondKey: React.ReactNode;
}

/**
 * Common "[Your hotkey] + [secondary]" prefix used on both shortcut
 * rows. Renders the user's actual hotkey as physical keycaps (or a
 * placeholder when unset) so the legend is literal — what you read is
 * what you press.
 */
function HotkeyPrefix({ keys, placeholder, secondKey }: HotkeyPrefixProps) {
	return (
		<span className="inline-flex items-center gap-1">
			{keys.length > 0 ? (
				keys.map((key, i) => (
					<span className="inline-flex items-center gap-1" key={key}>
						{i > 0 ? (
							<span aria-hidden className="text-[9px] text-foreground-dim">
								＋
							</span>
						) : null}
						<Keycap emphasized>{formatKeyName(key)}</Keycap>
					</span>
				))
			) : (
				<Keycap emphasized>{placeholder}</Keycap>
			)}
			<span aria-hidden className="px-0.5 text-[10px] text-foreground-dim">
				＋
			</span>
			{secondKey}
		</span>
	);
}

interface ModeChipProps {
	isCurrent: boolean;
	label: string;
	mode: RecordingMode;
}

/**
 * One link in the cycle chain. The active mode gets a saturated accent
 * border + glow; the others stay neutral so the chain reads as "you're
 * at X, ↑ takes you to the next one". Color matches
 * `RECORDING_MODE_COLOR_HEX` — same palette the tray icon, pill, and
 * settings switcher already use.
 */
function ModeChip({ label, mode, isCurrent }: ModeChipProps) {
	const accent = RECORDING_MODE_COLOR_HEX[mode];
	return (
		<span
			className="relative inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 ring-1 ring-white/[0.06] transition-colors duration-200"
			data-current={isCurrent || undefined}
			style={
				isCurrent
					? {
							boxShadow: `inset 0 0 0 1px ${accent}66, 0 0 10px -2px ${accent}88`,
							backgroundColor: `${accent}14`,
						}
					: undefined
			}
		>
			{/* Mode color dot — always visible, brightens when active. */}
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full"
				style={{
					backgroundColor: accent,
					boxShadow: isCurrent ? `0 0 6px 0 ${accent}` : undefined,
					opacity: isCurrent ? 1 : 0.55,
				}}
			/>
			<span
				className={`font-medium font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] ${
					isCurrent ? "text-foreground" : "text-foreground-secondary"
				}`}
			>
				{label}
			</span>
		</span>
	);
}

interface ShortcutRowProps {
	children: React.ReactNode;
	hint: React.ReactNode;
	prefix: React.ReactNode;
}

/**
 * One row of the legend: hotkey prefix on the left, action hint, then
 * the per-action visual body (a mode chain, an explanatory caption,
 * etc.). The rounded surface gives each row its own card without
 * dominating the panel.
 */
function ShortcutRow({ prefix, hint, children }: ShortcutRowProps) {
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-surface-1/40 px-3 py-2.5 ring-1 ring-white/[0.04]">
			<div className="flex flex-wrap items-center gap-3">
				{prefix}
				<span className="font-mono text-[10.5px] text-foreground-secondary uppercase tracking-[0.08em]">
					{hint}
				</span>
			</div>
			{children}
		</div>
	);
}

interface HotkeyShortcutsLegendProps {
	disabled?: boolean;
}

export function HotkeyShortcutsLegend({ disabled = false }: HotkeyShortcutsLegendProps) {
	const t = useTranslations("hotkey");
	const pushToTalkKey = useSettingsStore((s) => s.settings.hotkey?.pushToTalkKey ?? "");
	const recordingMode = useSettingsStore<RecordingMode>(
		(s) => (s.settings.general?.recordingMode as RecordingMode) ?? "ptt"
	);
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	const ttsHotkey = useSettingsStore((s) => s.settings.tts?.hotkey ?? "");

	const hotkeyParts = pushToTalkKey ? pushToTalkKey.split("+").filter(Boolean) : [];
	const ttsHotkeyParts = ttsHotkey ? ttsHotkey.split("+").filter(Boolean) : [];
	const placeholder = t("shortcutsLegendUnsetShort");

	return (
		<section
			aria-label={t("shortcutsLegendAriaLabel")}
			className={`flex flex-col gap-2 ${disabled ? "opacity-50" : ""}`}
		>
			{/* ── CYCLE MODE ROW ──────────────────────────────────────────
			    Visualises the cycle as a left-to-right chain. The active
			    mode glows in its accent color; arrows between chips show
			    the ↑ direction takes you forward one link; the trailing ↺
			    glyph hints "wraps around". */}
			<ShortcutRow
				hint={t("shortcutCycleMode")}
				prefix={
					<HotkeyPrefix
						keys={hotkeyParts}
						placeholder={placeholder}
						secondKey={
							<Keycap>
								<HugeiconsIcon
									className="text-foreground"
									icon={ArrowUp01Icon}
									size={11}
									strokeWidth={2.5}
								/>
							</Keycap>
						}
					/>
				}
			>
				<div className="flex flex-wrap items-center gap-1.5">
					{MODE_CYCLE_ORDER.map((mode, i) => (
						<span className="inline-flex items-center gap-1.5" key={mode}>
							{i > 0 ? (
								<HugeiconsIcon
									aria-hidden="true"
									className="text-foreground-dim"
									icon={ArrowRight01Icon}
									size={10}
									strokeWidth={2}
								/>
							) : null}
							<ModeChip
								isCurrent={recordingMode === mode}
								label={t(MODE_LABEL_KEY[mode])}
								mode={mode}
							/>
						</span>
					))}
					{/* Wrap-around hint — small ↻ glyph in the dim foreground
					    so it reads as "the chain loops back to the start". */}
					<span aria-hidden className="ml-1 text-[13px] text-foreground-dim leading-none">
						↻
					</span>
				</div>
			</ShortcutRow>

			{/* ── CANCEL ROW ──────────────────────────────────────────────
			    Backspace isn't directional — it's the escape hatch — so it
			    gets its own row with no visual chain. */}
			<ShortcutRow
				hint={t("shortcutCancel")}
				prefix={
					<HotkeyPrefix
						keys={hotkeyParts}
						placeholder={placeholder}
						// Unicode backspace glyph — no Backspace icon in
						// @hugeicons/core-free-icons. Well-supported in both
						// Geist Mono and the system mono fallback chain.
						secondKey={<Keycap>⌫</Keycap>}
					/>
				}
			>
				{null}
			</ShortcutRow>

			{/* ── TTS STOP ROW ─────────────────────────────────────────────
			    The Text-to-Speech hotkey is already configured above
			    ("Text-to-speech key" — it reads the active selection), so we
			    don't repeat a "read selection" row here. Held together with
			    Backspace it stops playback — the same "+⌫ is the escape hatch"
			    idiom as the cancel row above, and the only place that combo is
			    surfaced. Shown only when TTS is enabled so the legend stays
			    literal to what's actually armed. */}
			{ttsEnabled ? (
				<ShortcutRow
					hint={t("shortcutTtsStop")}
					prefix={
						<HotkeyPrefix
							keys={ttsHotkeyParts}
							placeholder={placeholder}
							secondKey={<Keycap>⌫</Keycap>}
						/>
					}
				>
					{null}
				</ShortcutRow>
			) : null}
		</section>
	);
}

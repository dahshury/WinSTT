import { Button as BaseButton } from "@base-ui/react/button";
import {
	CheckmarkCircle02Icon,
	Mic01Icon,
	MicOff01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	buildInputDeviceOptions,
	useInputDevices,
} from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Select } from "@/shared/ui/select";
import { useOnboardingWizardStore } from "../../model/wizard-store";

/** RMS threshold above which we count the mic test as "heard something". */
const PASS_THRESHOLD = 0.08;
/** Bar segments drawn for the live meter — matches the recording overlay's
 *  grain so the visual reads as a sibling, not a one-off. */
const METER_SEGMENTS = 28;
const METER_SPRING = {
	type: "spring",
	stiffness: 520,
	damping: 32,
	mass: 0.35,
} as const;
const MotionBaseButton = m.create(BaseButton);

/**
 * Step 2: device picker + live VU meter.
 *
 * Device picker uses the canonical `FormControl` + `ElevatedSurface` + `Select`
 * sandwich Settings uses for every dropdown. The VU meter sits inside its own
 * elevated card so it reads as a peer to the controls, not as a chrome
 * decoration.
 *
 * The meter runs on `navigator.mediaDevices.getUserMedia` with no `deviceId`
 * constraint — browser deviceIds do not line up with PyAudio indices, so
 * trying to match per-row is unreliable. The meter therefore tests "the
 * system default input" rather than the exact PyAudio device the user picked.
 * For most users that's the same device; for the rest, this is still a useful
 * "ANY mic is producing audio" sanity check.
 */
export function OnboardingMicTestStep() {
	const t = useTranslations("onboarding");
	const reduceMotion = useReducedMotion();
	const { devices, defaultDevice } = useInputDevices();
	const inputDeviceIndex = useSettingsStore(
		(s) => s.settings.audio.inputDeviceIndex,
	);
	const updateAudioSettings = useSettingsStore((s) => s.updateAudioSettings);
	const micTestPassed = useOnboardingWizardStore((s) => s.micTestPassed);
	const setMicTestPassed = useOnboardingWizardStore((s) => s.setMicTestPassed);
	const [level, setLevel] = useState(0);
	const [permission, setPermission] = useState<
		"pending" | "granted" | "denied"
	>("pending");

	useEffect(() => {
		let cancelled = false;
		let rafId = 0;
		let stream: MediaStream | null = null;
		let ctx: AudioContext | null = null;

		const start = async () => {
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				if (!cancelled) {
					setPermission("denied");
				}
				return;
			}
			if (cancelled) {
				for (const t of stream.getTracks()) {
					t.stop();
				}
				return;
			}
			setPermission("granted");
			ctx = new AudioContext();
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.5;
			source.connect(analyser);
			const buf = new Uint8Array(analyser.frequencyBinCount);
			const tick = () => {
				analyser.getByteFrequencyData(buf);
				let sum = 0;
				for (const v of buf) {
					sum += v * v;
				}
				const rms = Math.sqrt(sum / buf.length) / 255;
				setLevel(rms);
				if (rms > PASS_THRESHOLD) {
					setMicTestPassed(true);
				}
				rafId = requestAnimationFrame(tick);
			};
			tick();
		};

		start();
		return () => {
			cancelled = true;
			if (rafId) {
				cancelAnimationFrame(rafId);
			}
			ctx?.close().catch(() => undefined);
			if (stream) {
				for (const t of stream.getTracks()) {
					t.stop();
				}
			}
		};
	}, [setMicTestPassed]);

	const { deviceOptions, currentDeviceId } = buildInputDeviceOptions(
		devices,
		inputDeviceIndex,
		t("systemDefault"),
		defaultDevice?.name,
	);
	const handleDeviceChange = (id: string) => {
		const nextIndex = id === "default" ? null : Number.parseInt(id, 10);
		updateAudioSettings({
			inputDeviceIndex: Number.isFinite(nextIndex) ? nextIndex : null,
		});
	};

	return (
		<div className="flex flex-col gap-3">
			<FormControl
				caption={t("micCaption")}
				label={t("micLabel")}
				layout="stacked"
			>
				<m.div
					animate={{ opacity: 1, scale: 1, y: 0 }}
					initial={reduceMotion ? false : { opacity: 0.86, scale: 0.995, y: 2 }}
					key={currentDeviceId}
					transition={{
						duration: reduceMotion ? 0 : 0.2,
						ease: [0.22, 1, 0.36, 1],
					}}
				>
					<ElevatedSurface inline>
						<Select
							aria-label={t("micLabel")}
							onChange={handleDeviceChange}
							options={deviceOptions}
							value={currentDeviceId}
						/>
					</ElevatedSurface>
				</m.div>
			</FormControl>

			<FormControl label={t("levelTest")} layout="stacked">
				<ElevatedSurface>
					<div className="flex flex-col gap-2.5 px-2 py-1">
						<div className="flex items-center justify-between">
							<span className="font-medium font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.16em]">
								{t("speakNow")}
							</span>
							<AnimatePresence initial={false}>
								{micTestPassed ? (
									<m.span
										animate={{ opacity: 1, scale: 1, y: 0 }}
										className="inline-flex items-center gap-1 rounded-sm bg-teal/15 px-1.5 py-0.5 text-2xs text-teal ring-1 ring-teal/30"
										exit={{ opacity: 0, scale: 0.9, y: -2 }}
										initial={{ opacity: 0, scale: 0.85, y: 3 }}
										transition={{ type: "spring", stiffness: 620, damping: 28 }}
									>
										<HugeiconsIcon icon={CheckmarkCircle02Icon} size={10} />
										<span className="font-medium uppercase tracking-wider">
											{t("heardYou")}
										</span>
									</m.span>
								) : null}
							</AnimatePresence>
						</div>
						<Meter level={level} permission={permission} />
						{permission === "denied" ? (
							<p className="text-body-sm text-error leading-snug">
								{t("micBlocked")}
							</p>
						) : null}
						{permission === "granted" && !micTestPassed ? (
							<MotionBaseButton
								className="self-start font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.16em] underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
								onClick={() => setMicTestPassed(true)}
								whileHover={{ y: -1 }}
								whileTap={{ scale: 0.97 }}
								type="button"
							>
								{t("skipMicTest")}
							</MotionBaseButton>
						) : null}
					</div>
				</ElevatedSurface>
			</FormControl>
		</div>
	);
}

interface MeterProps {
	level: number;
	permission: "pending" | "granted" | "denied";
}

function Meter({ level, permission }: MeterProps) {
	const reduceMotion = useReducedMotion();
	const normalized =
		permission === "granted" ? Math.min(level / PASS_THRESHOLD, 1.25) : 0;
	const filled = normalized * METER_SEGMENTS;
	const meterPercent = Math.round(Math.min(normalized, 1) * 100);
	const Icon = permission === "denied" ? MicOff01Icon : Mic01Icon;
	const iconClass =
		permission === "denied" ? "text-error" : "text-foreground-muted";
	return (
		<>
			<meter
				aria-label="Microphone level"
				className="sr-only"
				max={100}
				min={0}
				value={meterPercent}
			/>
			<div className="relative flex items-center gap-2.5 overflow-hidden rounded-md bg-surface-2/70 px-2 py-2 ring-1 ring-divider">
				<m.span
					aria-hidden
					animate={{
						opacity:
							permission === "granted" ? Math.min(normalized * 0.28, 0.32) : 0,
					}}
					className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_50%,var(--color-teal)_0%,transparent_52%)]"
					transition={{ duration: reduceMotion ? 0 : 0.16 }}
				/>
				<m.span
					animate={{
						scale: permission === "granted" && normalized > 0.25 ? 1.08 : 1,
						color:
							permission === "denied"
								? "var(--color-error)"
								: "var(--color-foreground-muted)",
					}}
					className={cn("relative z-raised inline-flex shrink-0", iconClass)}
					transition={METER_SPRING}
				>
					<HugeiconsIcon icon={Icon} size={14} />
				</m.span>
				<div
					className="relative z-raised flex h-8 flex-1 items-end gap-[3px]"
					role="presentation"
				>
					{Array.from({ length: METER_SEGMENTS }, (_, i) => {
						const activity = Math.max(0, Math.min(1, filled - i));
						const active = activity > 0;
						const hot = i > METER_SEGMENTS * 0.78;
						const height =
							7 + activity * (hot ? 21 : 17) + Math.sin(i * 0.7) * activity * 4;
						return (
							<m.span
								className={cn(
									"flex-1 rounded-[2px] ring-1 ring-inset transition-colors duration-75 ease-linear",
									segmentClass(active, hot),
								)}
								animate={
									permission === "pending" && !reduceMotion
										? {
												height: [7, 18, 7],
												opacity: [0.25, 0.62, 0.25],
											}
										: {
												height: reduceMotion ? (active ? 18 : 7) : height,
												opacity: active ? 1 : 0.34,
												scaleY: active ? 1 : 0.72,
											}
								}
								key={`seg-${i}`}
								style={{ transformOrigin: "bottom" }}
								transition={
									permission === "pending" && !reduceMotion
										? {
												delay: i * 0.025,
												duration: 1.1,
												ease: "easeInOut",
												repeat: Infinity,
											}
										: METER_SPRING
								}
							/>
						);
					})}
				</div>
			</div>
		</>
	);
}

function segmentClass(active: boolean, hot: boolean): string {
	if (!active) {
		return "bg-surface-1/80 ring-1 ring-divider/60 ring-inset";
	}
	return hot ? "bg-warning ring-warning/60" : "bg-teal ring-teal/55";
}

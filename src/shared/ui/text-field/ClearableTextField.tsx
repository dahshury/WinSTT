import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ChangeEvent,
	type ComponentPropsWithoutRef,
	type ReactNode,
	type Ref,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/shared/lib/cn";
import { TextField } from "./TextField";

type TextFieldBaseProps = Omit<
	ComponentPropsWithoutRef<typeof TextField>,
	"className" | "onChange" | "placeholder" | "value"
>;

export interface ClearableTextFieldProps extends TextFieldBaseProps {
	clearLabel: string;
	className?: string;
	leadingIcon?: ReactNode;
	onValueChange: (value: string) => void;
	placeholder?: string;
	ref?: Ref<HTMLInputElement>;
	value: string;
	wrapperClassName?: string;
}

function readMs(name: string, fallback: number): number {
	const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function buildGlow(text: string, wrap: HTMLElement, input: HTMLInputElement): string {
	const canvas = document.createElement("canvas").getContext("2d");
	if (!canvas) {
		return "";
	}
	canvas.font = getComputedStyle(input).font;
	const width = wrap.clientWidth || 280;
	const padLeft = Number.parseFloat(getComputedStyle(input).paddingLeft) || 12;
	const spread = readMs("--glow-spread", 1.5);
	const layers: string[] = [];
	let x = 0;
	for (const segment of text.split(/(\s+)/)) {
		const segmentWidth = canvas.measureText(segment).width;
		if (segment.trim()) {
			const center = padLeft + x + segmentWidth / 2;
			const halfWidth = Math.max(segmentWidth * 0.45, 8) * spread;
			for (const [dx, widthRatio, radiusY, alpha] of [
				[0, 0.8, 7, 0.22],
				[halfWidth * 0.45, 0.55, 8, 0.18],
				[-halfWidth * 0.4, 0.65, 6, 0.16],
				[halfWidth * 0.15, 0.9, 5, 0.14],
			] as const) {
				const left = (((center + dx) / width) * 100).toFixed(2);
				const radiusX = Math.max(halfWidth * widthRatio, 2).toFixed(1);
				layers.push(
					`radial-gradient(ellipse ${radiusX}px ${radiusY}px at ${left}% 100%, rgba(255,255,255,${alpha}), transparent)`
				);
			}
		}
		x += segmentWidth;
	}
	return layers.join(", ");
}

function resetLayer(el: HTMLElement | null): void {
	if (!el) {
		return;
	}
	el.style.transform = "";
	el.style.opacity = "";
	el.style.filter = "";
}

export function ClearableTextField({
	clearLabel,
	className,
	leadingIcon,
	onValueChange,
	placeholder = "",
	ref,
	value,
	wrapperClassName,
	...rest
}: ClearableTextFieldProps) {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const mirrorRef = useRef<HTMLDivElement | null>(null);
	const placeholderRef = useRef<HTMLDivElement | null>(null);
	const glowRef = useRef<HTMLDivElement | null>(null);
	const rafRef = useRef<number | null>(null);
	const [clearing, setClearing] = useState(false);
	const hasValue = value.length > 0;
	const contentInset = cn("px-2.5", leadingIcon && "pl-8", "pr-8");

	useEffect(() => {
		return () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
			}
		};
	}, []);

	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		onValueChange(event.target.value);
	};

	const setInputRef = (node: HTMLInputElement | null) => {
		inputRef.current = node;
		if (typeof ref === "function") {
			ref(node);
		} else if (ref) {
			ref.current = node;
		}
	};

	const clear = () => {
		if (!value || clearing) {
			return;
		}
		onValueChange("");
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		const wrap = wrapRef.current;
		const input = inputRef.current;
		const mirror = mirrorRef.current;
		const placeholderEl = placeholderRef.current;
		const glow = glowRef.current;
		if (!(wrap && input && mirror && placeholderEl && glow)) {
			return;
		}
		const text = value.replace(/ /g, "\u00a0");
		mirror.textContent = text;
		glow.style.background = buildGlow(text, wrap, input);
		glow.style.opacity = "0";
		setClearing(true);

		const total = readMs("--clear-dur", 1000);
		const outDur = readMs("--clear-out-dur", 400);
		const inDur = readMs("--clear-in-dur", 400);
		const outFly = readMs("--clear-out-fly", 12);
		const inFly = readMs("--clear-in-fly", 12);
		const blur = readMs("--clear-blur", 2);
		const glowDelay = readMs("--glow-delay", 50);
		const peakAt = readMs("--glow-peak-at", 0.15);
		const glowOpacity = readMs("--glow-opacity", 0.85);
		const start = performance.now();

		const tick = (now: number) => {
			const elapsed = now - start;
			const outT = Math.min(1, elapsed / outDur);
			const inT = Math.min(1, elapsed / inDur);

			mirror.style.transform = `translateY(${(outT * outFly).toFixed(1)}px)`;
			mirror.style.opacity = (1 - outT).toFixed(3);
			mirror.style.filter = `blur(${(outT * blur).toFixed(1)}px)`;

			placeholderEl.style.transform = `translateY(${(-inFly + inT * inFly).toFixed(1)}px)`;
			placeholderEl.style.opacity = (0.9 + inT * 0.1).toFixed(3);
			placeholderEl.style.filter = `blur(${(blur - inT * blur).toFixed(1)}px)`;

			const glowT =
				elapsed <= glowDelay
					? 0
					: Math.min(1, (elapsed - glowDelay) / Math.max(1, total - glowDelay));
			const glowEnvelope =
				glowT < peakAt ? glowT / peakAt : 1 - (glowT - peakAt) / Math.max(0.001, 1 - peakAt);
			glow.style.opacity = (Math.max(0, glowEnvelope) * glowOpacity).toFixed(3);

			if (elapsed < total) {
				rafRef.current = requestAnimationFrame(tick);
				return;
			}
			setClearing(false);
			resetLayer(mirror);
			resetLayer(placeholderEl);
			mirror.textContent = "";
			glow.style.opacity = "";
			glow.style.background = "";
			input.focus({ preventScroll: true });
		};

		rafRef.current = requestAnimationFrame(tick);
	};

	return (
		<div
			className={cn("t-clear", (hasValue || clearing) && "has-value", clearing && "is-clearing", wrapperClassName)}
			ref={wrapRef}
		>
			{leadingIcon ? (
				<span className="pointer-events-none absolute top-1/2 left-2.5 z-raised -translate-y-1/2 text-foreground-muted">
					{leadingIcon}
				</span>
			) : null}
			<TextField
				{...rest}
				className={cn(leadingIcon && "pl-8", "pr-8", className)}
				onChange={handleChange}
				placeholder=""
				ref={setInputRef}
				value={value}
			/>
			<div
				aria-hidden="true"
				className={cn("t-clear-mirror text-body text-foreground", contentInset)}
				ref={mirrorRef}
			>
				{value.replace(/ /g, "\u00a0")}
			</div>
			<div
				aria-hidden="true"
				className={cn("t-clear-placeholder text-body text-foreground-muted", contentInset)}
				ref={placeholderRef}
			>
				{placeholder}
			</div>
			<div aria-hidden="true" className="t-clear-glow" ref={glowRef} />
			{hasValue ? (
				<button
					aria-label={clearLabel}
					className="absolute top-1/2 right-1.5 z-overlay flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-transparent text-foreground-muted outline-none transition-colors hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
					onClick={clear}
					onMouseDown={(event) => event.preventDefault()}
					type="button"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} size={12} />
				</button>
			) : null}
		</div>
	);
}

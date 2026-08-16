import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { useTranslations } from "use-intl";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { BreakdownSection } from "../lib/runtime-model-breakdown";
import { GpuModelBreakdown } from "./GpuModelBreakdown";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function Harness({ sections }: { sections: BreakdownSection[] }) {
	const t = useTranslations("statusBar");
	return (
		<GpuModelBreakdown
			sections={sections}
			t={t}
			usage={{
				device: "gpu",
				pools: {
					gpu: { usedBytes: 6 * GB, totalBytes: 24 * GB },
					cpu: { usedBytes: 8 * GB, totalBytes: 32 * GB },
				},
			}}
		/>
	);
}

function renderBreakdown(sections: BreakdownSection[]) {
	return render(
		<IntlProvider>
			<Harness sections={sections} />
		</IntlProvider>,
	);
}

afterEach(cleanup);

describe("GpuModelBreakdown", () => {
	test("renders all four section headings and the live usage header", () => {
		const { container } = renderBreakdown([
			{ key: "stt", rows: [] },
			{ key: "tts", rows: [] },
			{ key: "dictionary", rows: [] },
			{ key: "post", rows: [] },
		]);
		expect(screen.getByText("Speech-to-Text")).toBeDefined();
		expect(screen.getByText("Text-to-Speech")).toBeDefined();
		expect(screen.getByText("Dictionary")).toBeDefined();
		expect(screen.getByText("Post-processing")).toBeDefined();
		// Header reuses the {size} VRAM template with a "used / total" size.
		expect(screen.getByText(/6\.0 GB \/ 24\.0 GB VRAM/)).toBeDefined();
		// No local model bytes → the whole used span is one hatched System slice.
		const segments = container.querySelectorAll<HTMLElement>(
			'[data-slot="footprint-resource-segment"]',
		);
		expect(segments.length).toBe(1);
		expect(segments[0]?.dataset["section"]).toBe("system");
		expect(segments[0]?.style.width).toBe("25.00%");
		// Opening snapshots paint at their final width instead of visibly
		// transitioning from the hidden window's older sample.
		expect(segments[0]?.className).not.toContain("transition");
		// The System slice is spelled out in a legend line with its size.
		expect(screen.getByText("System")).toBeDefined();
		expect(screen.getByText("6.0 GB")).toBeDefined();
	});

	test("slices the meter per section, with the System remainder and a second meter for the other pool", () => {
		const { container } = renderBreakdown([
			{
				key: "stt",
				rows: [
					{
						key: "stt-main",
						name: "Whisper Large v3",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 1.5 * GB,
						diskBytes: 1.5 * GB,
						device: "gpu",
					},
				],
			},
			{
				key: "dictionary",
				rows: [
					{
						key: "dictionary",
						name: "mmBERT",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 800 * MB,
						diskBytes: 800 * MB,
						device: "cpu",
					},
				],
			},
		]);
		// Primary (VRAM) meter: STT slice 1.5/24 GB, System remainder 4.5/24 GB.
		const stt = container.querySelector<HTMLElement>('[data-section="stt"]');
		expect(stt?.style.width).toBe("6.25%");
		const systems = container.querySelectorAll<HTMLElement>(
			'[data-section="system"]',
		);
		expect(systems[0]?.style.width).toBe("18.75%");
		// Secondary (RAM) meter appears because the dictionary is CPU-resident:
		// its own figure line plus a dictionary slice of 800 MB / 32 GB.
		expect(screen.getByText(/8\.0 GB \/ 32\.0 GB RAM/)).toBeDefined();
		const dictionary = container.querySelector<HTMLElement>(
			'[data-section="dictionary"]',
		);
		expect(dictionary?.style.width).toBe("2.44%");
		// ...and the RAM pool's System remainder (8 GB − 800 MB).
		expect(systems.length).toBe(2);
		expect(systems[1]?.style.width).toBe("22.56%");
	});

	test("shows no secondary meter when every local model lives in the active pool", () => {
		const { container } = renderBreakdown([
			{
				key: "stt",
				rows: [
					{
						key: "stt-main",
						name: "Whisper Large v3",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 1.5 * GB,
						diskBytes: 1.5 * GB,
						device: "gpu",
					},
				],
			},
		]);
		expect(screen.queryByText(/32\.0 GB RAM/)).toBeNull();
		expect(
			container.querySelectorAll('[data-slot="footprint-resource-segment"]')
				.length,
		).toBe(2);
	});

	test("shows the VRAM memory tag plus a distinct disk figure for an STT model", () => {
		renderBreakdown([
			{
				key: "stt",
				rows: [
					{
						key: "stt-main",
						name: "Whisper Large v3",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 1.2 * GB,
						diskBytes: 800 * MB,
						device: "gpu",
					},
				],
			},
		]);
		expect(screen.getByText("Whisper Large v3")).toBeDefined();
		// Memory + disk render as icon + bare size; the full phrase is sr-only
		// (no native title — the breakdown itself sits inside a styled popup).
		expect(screen.getByText("1.2 GB")).toBeDefined();
		expect(screen.getByText("800 MB")).toBeDefined();
		expect(screen.getByText(/1\.2 GB VRAM/)).toBeDefined();
		expect(screen.getByText(/800 MB disk/)).toBeDefined();
	});

	test("tags CPU-only footprints (encoder dictionary) as RAM and hides the redundant disk figure", () => {
		renderBreakdown([
			{
				key: "dictionary",
				rows: [
					{
						key: "dictionary",
						name: "mmBERT",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 310 * MB,
						diskBytes: 310 * MB,
						device: "cpu",
					},
				],
			},
		]);
		// Icon + bare size visible; the "RAM" phrase is sr-only (CPU device → CpuIcon).
		expect(screen.getByText("310 MB")).toBeDefined();
		expect(screen.getByText(/310 MB RAM/)).toBeDefined();
		// memBytes === diskBytes, so no separate disk figure is rendered at all.
		expect(screen.queryByText(/disk/)).toBeNull();
	});

	test("shows each section's footprint as a share of the used device memory", () => {
		// STT on GPU: 1.5 GB of the 6 GB used VRAM → 25%. Dictionary on CPU:
		// 800 MB of the 8 GB used RAM → 10% (a different pool, by design).
		renderBreakdown([
			{
				key: "stt",
				rows: [
					{
						key: "stt-main",
						name: "Whisper Large v3",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 1.5 * GB,
						diskBytes: 1.5 * GB,
						device: "gpu",
					},
				],
			},
			{
				key: "dictionary",
				rows: [
					{
						key: "dictionary",
						name: "mmBERT",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 800 * MB,
						diskBytes: 800 * MB,
						device: "cpu",
					},
				],
			},
		]);
		expect(screen.getByText("25%")).toBeDefined();
		expect(screen.getByText("10%")).toBeDefined();
	});

	test("omits the share for sections with no local footprint", () => {
		renderBreakdown([
			{
				key: "tts",
				rows: [
					{
						key: "tts",
						name: null,
						status: "off",
						detail: null,
						live: false,
						memBytes: null,
						diskBytes: null,
						device: null,
					},
				],
			},
		]);
		expect(screen.queryByText("%", { exact: false })).toBeNull();
	});

	test("leads a loaded model with its maker logo when a logoSrc is provided", () => {
		const { container } = renderBreakdown([
			{
				key: "stt",
				rows: [
					{
						key: "stt-main",
						name: "Dolphin Base",
						status: null,
						detail: "int8",
						live: false,
						memBytes: 60 * MB,
						diskBytes: 99 * MB,
						device: "gpu",
						logoSrc: "/provider-icons/dataoceanai.png",
					},
				],
			},
		]);
		expect(
			container.querySelector(
				'[data-logo-src="/provider-icons/dataoceanai.png"]',
			),
		).not.toBeNull();
	});

	test("renders the translated status word for off / cloud rows", () => {
		renderBreakdown([
			{
				key: "tts",
				rows: [
					{
						key: "tts",
						name: null,
						status: "off",
						detail: null,
						live: false,
						memBytes: null,
						diskBytes: null,
						device: null,
					},
				],
			},
			{
				key: "post",
				rows: [
					{
						key: "post",
						name: null,
						status: "cloud",
						detail: "openai/gpt-4o-mini",
						live: false,
						memBytes: null,
						diskBytes: null,
						device: null,
					},
				],
			},
		]);
		expect(screen.getByText("Off")).toBeDefined();
		expect(screen.getByText("Cloud")).toBeDefined();
		expect(screen.getByText("openai/gpt-4o-mini")).toBeDefined();
	});
});

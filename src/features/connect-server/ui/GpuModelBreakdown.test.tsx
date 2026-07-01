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
				totalBytes: 24 * GB,
				usedBytes: 6 * GB,
				usedByDevice: { gpu: 6 * GB, cpu: 8 * GB },
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
		renderBreakdown([
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
		// Memory + disk now render as icon + bare size; the unit lives on the title.
		expect(screen.getByText("1.2 GB")).toBeDefined();
		expect(screen.getByText("800 MB")).toBeDefined();
		expect(screen.getByTitle(/1\.2 GB VRAM/)).toBeDefined();
		expect(screen.getByTitle(/800 MB disk/)).toBeDefined();
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
		// Icon + bare size visible; "RAM" lives on the title (CPU device → CpuIcon).
		expect(screen.getByText("310 MB")).toBeDefined();
		expect(screen.getByTitle(/310 MB RAM/)).toBeDefined();
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

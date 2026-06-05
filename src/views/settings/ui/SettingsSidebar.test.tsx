import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Tabs } from "@base-ui/react/tabs";
import { Cancel01Icon, Settings05Icon } from "@hugeicons/core-free-icons";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useModelStateStore } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import type {
	LiveResourcesEntry,
	ModelStateEntry,
} from "@/shared/api/ipc-client";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const links: SidebarLink[] = [
	{
		key: "general",
		label: "General",
		icon: Settings05Icon,
		keywords: "Recording Display Startup language wake word",
	},
	{
		key: "audio",
		label: "Audio",
		icon: Cancel01Icon,
		tooltip: "Audio configuration",
	},
];

const GB = 1024 ** 3;
const originalResourceRefresh = useSystemResourcesStore.getState().refresh;

function renderSidebar() {
	return render(
		<IntlProvider>
			<Tabs.Root defaultValue="general">
				<SettingsSidebar links={links} />
			</Tabs.Root>
		</IntlProvider>,
	);
}

function liveResourcesWithGpu(): LiveResourcesEntry {
	return {
		cpu_count_logical: 16,
		cpu_count_physical: 8,
		cpu_percent: 12,
		gpus: [
			{
				name: "RTX 4090",
				total_vram_bytes: 24 * GB,
				free_vram_bytes: 18 * GB,
				used_vram_bytes: 6 * GB,
				utilization_percent: 18,
			},
		],
		ram_available_bytes: 48 * GB,
		ram_total_bytes: 64 * GB,
	};
}

function modelState(
	id: string,
	effectiveQuantization: string,
): ModelStateEntry {
	return {
		id,
		estimated_bytes: 1_000_000,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: ["", "fp16", "int8"],
		cache_by_quantization: {},
		cache: {
			downloaded_bytes: 0,
			progress: 0,
			state: "not_cached",
			total_bytes: 1_000_000,
		},
		effective_quantization: effectiveQuantization,
	};
}

function setModelSettings(patch: Partial<typeof DEFAULT_SETTINGS.model>): void {
	useSettingsStore.setState((state) => ({
		settings: {
			...state.settings,
			model: { ...state.settings.model, ...patch },
		},
	}));
}

// The field is always mounted (so it can animate in/out) but `aria-hidden` while
// folded, so a role query only finds it once it's open. Click the affordance,
// then return the now-accessible textbox.
function openSearch() {
	fireEvent.click(screen.getByRole("button", { name: /search/i }));
	return screen.getByRole("textbox");
}

describe("SettingsSidebar", () => {
	// The collapsed preference persists to localStorage; clear it between tests
	// so a collapse in one test doesn't bleed into the next (which assumes the
	// default expanded layout).
	beforeEach(() => {
		try {
			window.localStorage.clear();
		} catch {
			// no localStorage in this env — nothing to reset
		}
		useSettingsStore.setState({
			settings: structuredClone(DEFAULT_SETTINGS),
			isLoaded: true,
		});
		useModelStateStore.setState({
			statesById: {},
			systemInfo: null,
			isLoaded: false,
		});
		useSystemResourcesStore.setState({
			liveResources: null,
			isLoading: false,
			error: null,
			lastFetchedAt: null,
			refresh: async () => {
				/* keep synthetic snapshots stable in sidebar tests */
			},
		});
	});

	test("renders one tab per link", () => {
		renderSidebar();
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(links.length);
	});

	test("does not render a reset control (reset lives in General settings now)", () => {
		renderSidebar();
		expect(screen.queryByRole("button", { name: /Reset/i })).toBeNull();
	});

	test("does not render a close button (it lives in the content card now)", () => {
		renderSidebar();
		expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
	});

	test("search field stays out of reach until the affordance is clicked", () => {
		renderSidebar();
		// Folded: the field is aria-hidden, so no accessible textbox.
		expect(screen.queryByRole("textbox")).toBeNull();
		openSearch();
		expect(screen.queryByRole("textbox")).not.toBeNull();
	});

	test("search field opens as a bordered field without the accent focus ring", () => {
		renderSidebar();
		const search = openSearch();

		expect(search.className).toContain("border-border");
		expect(search.className).toContain("focus-visible:ring-0");
	});

	test("exposes a taller top drag strip above the sidebar controls", () => {
		renderSidebar();
		const dragStrip = document.querySelector(
			'[data-slot="settings-sidebar-top-drag"]',
		);

		expect(dragStrip?.className).toContain("titlebar-drag");
		expect(dragStrip?.className).toContain("h-3.5");
	});

	test("hides the Settings wordmark while the search field is open", () => {
		renderSidebar();
		expect(screen.getByText("Settings")).toBeDefined();
		openSearch();
		expect(screen.queryByText("Settings")).toBeNull();
	});

	test("filters the tab list by label as you type", () => {
		renderSidebar();
		const search = openSearch();
		fireEvent.change(search, { target: { value: "audio" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("Audio");
		expect(tabs[0]?.closest("[data-settings-search-result]")).not.toBeNull();
	});

	test("search also matches a tab's description text", () => {
		renderSidebar();
		const search = openSearch();
		// "configuration" only appears in the Audio tab's tooltip, not its label
		fireEvent.change(search, { target: { value: "configuration" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("Audio");
	});

	test("search matches a tab's section/setting keywords, not just its label", () => {
		renderSidebar();
		const search = openSearch();
		// "display" only appears in General's keywords (a section name) — neither
		// its label nor tooltip. This is the reported bug.
		fireEvent.change(search, { target: { value: "display" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("General");
	});

	test("search tolerates typos via fuzzy matching", () => {
		renderSidebar();
		const search = openSearch();
		fireEvent.change(search, { target: { value: "dispaly" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("General");
	});

	test("shows a no-results message when nothing matches", () => {
		renderSidebar();
		const search = openSearch();
		fireEvent.change(search, { target: { value: "zzzznomatch" } });
		expect(screen.queryAllByRole("tab")).toHaveLength(0);
	});

	test("collapses to an icon rail (hides labels) and toggles back", () => {
		renderSidebar();
		// Expanded: tab labels visible.
		expect(screen.getByText("General")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /collapse sidebar/i }));

		// Collapsed: tab labels removed (icon-only), tabs remain.
		expect(screen.queryByText("General")).toBeNull();
		expect(screen.getAllByRole("tab")).toHaveLength(links.length);
		expect(screen.queryByRole("button", { name: /search/i })).toBeNull();

		// The toggle flips to an expand affordance and restores the rail.
		fireEvent.click(screen.getByRole("button", { name: /expand sidebar/i }));
		expect(screen.getByText("General")).toBeDefined();
	});

	test("shows only RAM when local models are CPU-pinned", () => {
		useSystemResourcesStore.setState({ liveResources: liveResourcesWithGpu() });
		setModelSettings({ device: "cpu", onnxQuantization: "fp16" });

		renderSidebar();

		expect(screen.getByText("RAM")).toBeDefined();
		expect(screen.queryByText("VRAM")).toBeNull();
	});

	test("shows only VRAM when all local models target the GPU", () => {
		useSystemResourcesStore.setState({ liveResources: liveResourcesWithGpu() });
		setModelSettings({ device: "auto", onnxQuantization: "fp16" });

		renderSidebar();

		expect(screen.queryByText("RAM")).toBeNull();
		expect(screen.getByText("VRAM")).toBeDefined();
	});

	test("shows both RAM and VRAM when local slots split across CPU and GPU", () => {
		useSystemResourcesStore.setState({ liveResources: liveResourcesWithGpu() });
		setModelSettings({
			device: "auto",
			model: "gpu-model",
			realtimeModel: "cpu-model",
			onnxQuantization: "auto",
		});
		useModelStateStore.setState({
			statesById: {
				"gpu-model": modelState("gpu-model", "fp16"),
				"cpu-model": modelState("cpu-model", "int8"),
			},
			isLoaded: true,
		});

		renderSidebar();

		expect(screen.getByText("RAM")).toBeDefined();
		expect(screen.getByText("VRAM")).toBeDefined();
	});
});

afterAll(() => {
	useSystemResourcesStore.setState({
		liveResources: null,
		isLoading: false,
		error: null,
		lastFetchedAt: null,
		refresh: originalResourceRefresh,
	});
});

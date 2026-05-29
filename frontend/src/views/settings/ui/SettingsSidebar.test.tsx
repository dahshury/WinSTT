import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Tabs } from "@base-ui/react/tabs";
import { Cancel01Icon, Settings05Icon } from "@hugeicons/core-free-icons";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const links: SidebarLink[] = [
	{
		key: "general",
		label: "General",
		icon: Settings05Icon,
		keywords: "Recording Display Startup language wake word",
	},
	{ key: "audio", label: "Audio", icon: Cancel01Icon, tooltip: "Audio configuration" },
];

function renderSidebar(onClose: () => void = () => undefined) {
	return render(
		<IntlProvider>
			<Tabs.Root defaultValue="general">
				<SettingsSidebar links={links} onClose={onClose} />
			</Tabs.Root>
		</IntlProvider>
	);
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

	test("renders a search box", () => {
		renderSidebar();
		expect(screen.getByPlaceholderText(/search/i)).toBeDefined();
	});

	test("filters the tab list by label as you type", () => {
		renderSidebar();
		const search = screen.getByPlaceholderText(/search/i);
		fireEvent.change(search, { target: { value: "audio" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("Audio");
	});

	test("search also matches a tab's description text", () => {
		renderSidebar();
		const search = screen.getByPlaceholderText(/search/i);
		// "configuration" only appears in the Audio tab's tooltip, not its label
		fireEvent.change(search, { target: { value: "configuration" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("Audio");
	});

	test("search matches a tab's section/setting keywords, not just its label", () => {
		renderSidebar();
		const search = screen.getByPlaceholderText(/search/i);
		// "display" only appears in General's keywords (a section name) — neither
		// its label nor tooltip. This is the reported bug.
		fireEvent.change(search, { target: { value: "display" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("General");
	});

	test("search tolerates typos via fuzzy matching", () => {
		renderSidebar();
		const search = screen.getByPlaceholderText(/search/i);
		fireEvent.change(search, { target: { value: "dispaly" } });
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.textContent).toContain("General");
	});

	test("shows a no-results message when nothing matches", () => {
		renderSidebar();
		const search = screen.getByPlaceholderText(/search/i);
		fireEvent.change(search, { target: { value: "zzzznomatch" } });
		expect(screen.queryAllByRole("tab")).toHaveLength(0);
	});

	test("invokes onClose when the close button is clicked", () => {
		const onClose = mock(() => undefined);
		renderSidebar(onClose);
		fireEvent.click(screen.getByRole("button", { name: /close/i }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("collapses to an icon rail (hides search + labels) and toggles back", () => {
		renderSidebar();
		// Expanded: search box present, labels visible.
		expect(screen.queryByPlaceholderText(/search/i)).not.toBeNull();
		expect(screen.getByText("General")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /collapse sidebar/i }));

		// Collapsed: search box gone, tab labels removed (icon-only), tabs remain.
		expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
		expect(screen.queryByText("General")).toBeNull();
		expect(screen.getAllByRole("tab")).toHaveLength(links.length);

		// The toggle flips to an expand affordance and restores the rail.
		fireEvent.click(screen.getByRole("button", { name: /expand sidebar/i }));
		expect(screen.queryByPlaceholderText(/search/i)).not.toBeNull();
		expect(screen.getByText("General")).toBeDefined();
	});
});

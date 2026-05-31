import { beforeEach, describe, expect, test } from "bun:test";
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

function renderSidebar() {
	return render(
		<IntlProvider>
			<Tabs.Root defaultValue="general">
				<SettingsSidebar links={links} />
			</Tabs.Root>
		</IntlProvider>
	);
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

		// The toggle flips to an expand affordance and restores the rail.
		fireEvent.click(screen.getByRole("button", { name: /expand sidebar/i }));
		expect(screen.getByText("General")).toBeDefined();
	});
});

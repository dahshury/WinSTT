import { describe, expect, test } from "bun:test";
import { Tabs } from "@base-ui/react/tabs";
import { Cancel01Icon, Settings05Icon } from "@hugeicons/core-free-icons";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const links: SidebarLink[] = [
	{ key: "general", label: "General", icon: Settings05Icon },
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

describe("SettingsSidebar", () => {
	test("renders one tab per link (label is hidden until expanded)", () => {
		renderSidebar();
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(links.length);
	});

	test("does not render a reset control (reset lives in General settings now)", () => {
		renderSidebar();
		expect(screen.queryByRole("button", { name: /Reset/i })).toBeNull();
	});

	test("expands width on mouse enter and contracts on mouse leave", () => {
		renderSidebar();
		// The rail is split into an outer flow-spacer (fixed 60px) and an
		// absolutely-positioned inner panel that actually expands on
		// hover/focus. Both carry an inline `width`, so we target the inner
		// one by its layout class.
		const panel = document.body.querySelector("div.absolute[style*='width']") as HTMLElement | null;
		expect(panel).not.toBeNull();
		fireEvent.mouseEnter(panel!);
		expect(panel!.style.width).toBe("196px");
		fireEvent.mouseLeave(panel!);
		expect(panel!.style.width).toBe("60px");
	});

	test("does not expand on non-keyboard focus (e.g. window-focus restoration from taskbar)", () => {
		// Regression guard: clicking the taskbar icon while settings is open
		// would restore focus to the last-active Tab inside the rail, and the
		// onFocus handler used to expand the sidebar unconditionally. We now
		// gate that on :focus-visible so only keyboard navigation triggers it.
		renderSidebar();
		const panel = document.body.querySelector("div.absolute[style*='width']") as HTMLElement | null;
		expect(panel).not.toBeNull();
		// Synthetic focus events in jsdom don't match :focus-visible — that's
		// exactly the case we're guarding against (programmatic / mouse focus).
		const firstTab = screen.getAllByRole("tab")[0] as HTMLElement;
		fireEvent.focus(firstTab);
		expect(panel!.style.width).toBe("60px");
	});
});

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

	test("expands width on focus and contracts on blur", () => {
		renderSidebar();
		// The first child div is the sidebar wrapper carrying inline width style
		const wrapper = document.body.querySelector("div[style*='width']") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		fireEvent.focus(wrapper!);
		expect(wrapper!.style.width).toBe("196px");
		fireEvent.mouseLeave(wrapper!);
		fireEvent.blur(wrapper!);
		expect(wrapper!.style.width).toBe("60px");
	});
});

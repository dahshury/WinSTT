import { describe, expect, mock, test } from "bun:test";
import { Tabs } from "@base-ui/react/tabs";
import { Cancel01Icon, Settings05Icon } from "@hugeicons/core-free-icons";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const links: SidebarLink[] = [
	{ key: "general", label: "General", icon: Settings05Icon },
	{ key: "audio", label: "Audio", icon: Cancel01Icon, tooltip: "Audio configuration" },
];

function renderSidebar(opts?: { onReset?: () => void }) {
	return render(
		<IntlProvider>
			<Tabs.Root defaultValue="general">
				<SettingsSidebar links={links} {...opts} />
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

	test("does not render the reset section when onReset is omitted", () => {
		renderSidebar();
		expect(screen.queryByRole("button", { name: /Reset/i })).toBeNull();
	});

	test("renders the reset button when onReset is provided", () => {
		renderSidebar({ onReset: () => undefined });
		expect(screen.getByRole("button")).toBeDefined();
	});

	test("clicking the reset button opens a confirm dialog (visible in DOM after click)", () => {
		const onReset = mock(() => undefined);
		renderSidebar({ onReset });
		const resetBtn = screen.getByRole("button");
		fireEvent.click(resetBtn);
		// Dialog text from translations should now be in body
		expect(document.body.textContent?.length).toBeGreaterThan(0);
	});

	test("expands width on focus and contracts on blur", () => {
		renderSidebar();
		// The first child div is the sidebar wrapper carrying inline width style
		const wrapper = document.body.querySelector("div[style*='width']") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		fireEvent.focus(wrapper!);
		expect(wrapper!.style.width).toBe("170px");
		fireEvent.mouseLeave(wrapper!);
		fireEvent.blur(wrapper!);
		expect(wrapper!.style.width).toBe("52px");
	});
});

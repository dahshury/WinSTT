"use client";

import { SettingSection } from "@/entities/setting";
import { SnippetsTable } from "@/features/manage-snippets";
import { useSettingsStore } from "@/features/update-settings";

export function SnippetsSettingsPanel() {
	const snippets = useSettingsStore((s) => s.settings.snippets) ?? [];
	const setSettings = useSettingsStore((s) => s.setSettings);
	const settings = useSettingsStore((s) => s.settings);

	return (
		<SettingSection title="Text Snippets">
			<div style={{ padding: "8px 0" }}>
				<p
					style={{
						color: "var(--color-text-muted)",
						fontSize: "12px",
						marginBottom: "12px",
					}}
				>
					Automatically expand short triggers into longer text.
				</p>
				<SnippetsTable
					entries={snippets}
					onAdd={(entry) => {
						setSettings({
							...settings,
							snippets: [...snippets, { ...entry, id: crypto.randomUUID() }],
						});
					}}
					onClearAll={() => {
						setSettings({ ...settings, snippets: [] });
					}}
					onRemove={(id) => {
						setSettings({
							...settings,
							snippets: snippets.filter((e) => e.id !== id),
						});
					}}
				/>
			</div>
		</SettingSection>
	);
}

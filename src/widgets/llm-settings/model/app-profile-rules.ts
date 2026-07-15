import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import type {
	LlmConfiguration,
	SavedConfiguration,
} from "./configuration-types";

export type AppProfileRule =
	AppSettingsOutput["llm"]["appProfiles"]["rules"][number];
export type AppProfileConfig = AppProfileRule["config"];

export function normalizeExeInput(value: string): string {
	return (value.trim().split(/[\\/]/).pop() ?? "").toLowerCase();
}

export function normalizeUrlPatternInput(value: string): string {
	let normalized = value.trim().toLowerCase();
	normalized = normalized.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
	normalized = normalized.split(/[/?#]/, 1)[0] ?? "";
	normalized = normalized.replace(/:\d+$/, "").replace(/^www\./, "");
	return normalized.replace(/\.$/, "");
}

export function ruleIsValid(
	rule: Pick<
		AppProfileRule,
		"appExe" | "titlePattern" | "urlPattern" | "configurationId"
	>,
): boolean {
	return Boolean(
		rule.configurationId.trim() &&
			(rule.appExe.trim() ||
				rule.titlePattern.trim() ||
				rule.urlPattern.trim()),
	);
}

export function configSnapshotFromSavedConfiguration(
	config: LlmConfiguration,
): AppProfileConfig {
	const { enabled: _enabled, ...snapshot } = config;
	return {
		...snapshot,
		presets: snapshot.presets.map((preset) => ({ ...preset })),
		customModifiers: snapshot.customModifiers.map((modifier) => ({
			...modifier,
		})),
	};
}

export function syncRuleSnapshots(
	rules: readonly AppProfileRule[],
	configurations: readonly SavedConfiguration[],
): { rules: AppProfileRule[]; changed: boolean } {
	const byId = new Map(configurations.map((entry) => [entry.id, entry]));
	let changed = false;
	const next = rules.map((rule) => {
		const configuration = byId.get(rule.configurationId);
		if (!configuration) {
			return rule;
		}
		const config = configSnapshotFromSavedConfiguration(configuration.config);
		if (
			rule.configurationName === configuration.name &&
			JSON.stringify(rule.config) === JSON.stringify(config)
		) {
			return rule;
		}
		changed = true;
		return {
			...rule,
			configurationName: configuration.name,
			config,
		};
	});
	return { rules: next, changed };
}

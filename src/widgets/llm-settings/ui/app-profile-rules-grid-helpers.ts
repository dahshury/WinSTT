import type { ContextAppEntry } from "@/shared/api/ipc-client";
import {
	configSnapshotFromSavedConfiguration,
	normalizeExeInput,
	normalizeUrlPatternInput,
	type AppProfileRule,
} from "../model/app-profile-rules";
import type { SavedConfiguration } from "../model/configuration-types";

interface SelectOption {
	label: string;
	value: string;
}

export function buildAppProfileAppOptions(
	apps: readonly ContextAppEntry[],
	rules: readonly AppProfileRule[],
): SelectOption[] {
	const options = new Map<string, SelectOption>();
	for (const app of apps) {
		const value = normalizeExeInput(app.exe || app.id);
		if (!value) {
			continue;
		}
		options.set(value, {
			label:
				app.label && app.label !== value ? `${app.label} — ${value}` : value,
			value,
		});
	}
	for (const rule of rules) {
		const value = normalizeExeInput(rule.appExe);
		if (value && !options.has(value)) {
			options.set(value, { label: value, value });
		}
	}
	return [...options.values()];
}

export function reconcileAppProfileRules(
	rules: readonly AppProfileRule[],
	configurations: readonly SavedConfiguration[],
): AppProfileRule[] {
	const configurationsById = new Map(
		configurations.map((configuration) => [configuration.id, configuration]),
	);
	return rules.map((rule) => {
		const configuration = configurationsById.get(rule.configurationId);
		return {
			appExe: normalizeExeInput(rule.appExe),
			config: configuration
				? configSnapshotFromSavedConfiguration(configuration.config)
				: rule.config,
			configurationId: rule.configurationId,
			configurationName: configuration?.name ?? rule.configurationName,
			enabled: rule.enabled,
			id: rule.id,
			titlePattern: rule.titlePattern.trim(),
			urlPattern: normalizeUrlPatternInput(rule.urlPattern),
		};
	});
}

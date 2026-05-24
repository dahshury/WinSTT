"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatProviderName } from "./openrouter-provider-utils";

export const ALL_PROVIDERS_VALUE = "__all__";

export function filterEndpointProviders(
	providers: [string, number][],
	queryLower: string
): [string, number][] {
	if (!queryLower) {
		return providers;
	}
	return providers.filter(([p]) => p.toLowerCase().includes(queryLower));
}

export function resolveSelection(value: string | null): string | null | "noop" {
	if (value === ALL_PROVIDERS_VALUE) {
		return null;
	}
	if (value) {
		return value;
	}
	return "noop";
}

export function isTickVisible(selectedProvider: string | null, matchValue: string | null): boolean {
	return selectedProvider === matchValue;
}

export function resolveComboboxValue(selectedEndpointProvider: string | null): string {
	return selectedEndpointProvider || ALL_PROVIDERS_VALUE;
}

export function applyProviderChange(
	value: string | null,
	onEndpointProviderSelect: (provider: string | null) => void
): void {
	const resolved = resolveSelection(value);
	if (resolved !== "noop") {
		onEndpointProviderSelect(resolved);
	}
}

interface SelectedTickProps {
	visible: boolean;
}

export function SelectedTick({ visible }: SelectedTickProps) {
	if (!visible) {
		return null;
	}
	return <HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />;
}

const ITEM_CLASS =
	"flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[highlighted]:bg-surface-hover";

interface AllProvidersItemProps {
	isSelected: boolean;
}

function AllProvidersItem({ isSelected }: AllProvidersItemProps) {
	return (
		<Combobox.Item className={ITEM_CLASS} key={ALL_PROVIDERS_VALUE} value={ALL_PROVIDERS_VALUE}>
			<HugeiconsIcon className="me-2 size-4" icon={ServerStack01Icon} />
			<span className="flex-1">All Providers</span>
			<SelectedTick visible={isSelected} />
		</Combobox.Item>
	);
}

interface ProviderItemProps {
	count: number;
	isSelected: boolean;
	provider: string;
}

function ProviderItem({ count, isSelected, provider }: ProviderItemProps) {
	return (
		<Combobox.Item className={ITEM_CLASS} key={provider} value={provider}>
			<HugeiconsIcon className="me-2 size-4" icon={ServerStack01Icon} />
			<span className="flex-1">{formatProviderName(provider)}</span>
			<SelectedTick visible={isSelected} />
			<span className="text-2xs text-foreground-muted">({count})</span>
		</Combobox.Item>
	);
}

export interface ItemContext {
	counts: Map<string, number>;
	selectedEndpointProvider: string | null;
}

export function renderProviderRow(provider: string, ctx: ItemContext) {
	if (provider === ALL_PROVIDERS_VALUE) {
		return <AllProvidersItem isSelected={ctx.selectedEndpointProvider === null} />;
	}
	const count = ctx.counts.get(provider) ?? 0;
	return (
		<ProviderItem
			count={count}
			isSelected={ctx.selectedEndpointProvider === provider}
			provider={provider}
		/>
	);
}

export const __endpoint_provider_filter_submenu_test_helpers__ = {
	ALL_PROVIDERS_VALUE,
	filterEndpointProviders,
	resolveSelection,
	renderProviderRow,
	isTickVisible,
	applyProviderChange,
	resolveComboboxValue,
	SelectedTick,
};

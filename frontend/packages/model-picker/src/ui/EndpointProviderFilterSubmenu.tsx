"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { formatProviderName } from "../lib/openrouter-provider-utils";
import { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "./DropdownMenu";

const PROVIDER_RENDER_LIMIT = 100;

const ALL_PROVIDERS_VALUE = "__all__";

export interface EndpointProviderFilterSubmenuProps {
	endpointProviders: [string, number][];
	onEndpointProviderSelect: (provider: string | null) => void;
	selectedEndpointProvider: string | null;
}

function filterEndpointProviders(
	providers: [string, number][],
	queryLower: string
): [string, number][] {
	if (!queryLower) {
		return providers;
	}
	return providers.filter(([p]) => p.toLowerCase().includes(queryLower));
}

function resolveSelection(value: string | null): string | null | "noop" {
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

/** Returns the current combobox value: the provider slug or the "all" sentinel. */
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

function SelectedTick({ visible }: SelectedTickProps) {
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

interface ItemContext {
	counts: Map<string, number>;
	selectedEndpointProvider: string | null;
}

function renderProviderRow(provider: string, ctx: ItemContext) {
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

export function EndpointProviderFilterSubmenu({
	endpointProviders,
	selectedEndpointProvider,
	onEndpointProviderSelect,
}: EndpointProviderFilterSubmenuProps) {
	const [search, setSearch] = useState("");
	const queryLower = search.toLowerCase();
	const filtered = filterEndpointProviders(endpointProviders, queryLower);
	const items: string[] = [ALL_PROVIDERS_VALUE, ...filtered.map(([name]) => name)];
	const counts = new Map(filtered);

	const handleChange = (value: string | null) => {
		applyProviderChange(value, onEndpointProviderSelect);
	};

	const itemCtx: ItemContext = { counts, selectedEndpointProvider };

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="me-2 size-4" icon={ServerStack01Icon} />
				<span>Endpoint Provider</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-64 p-0">
				<Combobox.Root
					inline
					items={items}
					limit={PROVIDER_RENDER_LIMIT}
					onInputValueChange={setSearch}
					onValueChange={(value: string | null) => handleChange(value)}
					open
					value={resolveComboboxValue(selectedEndpointProvider)}
				>
					<div className="flex h-full flex-col">
						<div className="p-2">
							<Combobox.Input
								className="h-8 w-full rounded-sm border border-border bg-surface-tertiary px-2.5 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
								placeholder="Search providers"
							/>
						</div>
						<Combobox.Empty className="py-4 text-center text-body text-foreground-muted">
							No providers found.
						</Combobox.Empty>
						<Combobox.List className="h-64 overflow-y-auto">
							<Combobox.Collection>
								{(provider: string) => renderProviderRow(provider, itemCtx)}
							</Combobox.Collection>
						</Combobox.List>
					</div>
				</Combobox.Root>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
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

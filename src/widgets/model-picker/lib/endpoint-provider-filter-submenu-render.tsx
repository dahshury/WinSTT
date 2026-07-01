"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SelectedTick } from "./endpoint-provider-filter-submenu-components";
import {
	ALL_PROVIDERS_VALUE,
	type ItemContext,
} from "./endpoint-provider-filter-submenu-utils";
import { formatProviderName } from "./openrouter-provider-utils";

const ITEM_CLASS =
	"flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[highlighted]:bg-surface-hover";

function renderAllProviders(isSelected: boolean, label: string) {
	return (
		<Combobox.Item
			className={ITEM_CLASS}
			key={ALL_PROVIDERS_VALUE}
			value={ALL_PROVIDERS_VALUE}
		>
			<HugeiconsIcon className="me-2 size-4" icon={ServerStack01Icon} />
			<span className="flex-1">{label}</span>
			<SelectedTick visible={isSelected} />
		</Combobox.Item>
	);
}

function renderProviderItem(
	provider: string,
	count: number,
	isSelected: boolean,
) {
	return (
		<Combobox.Item className={ITEM_CLASS} key={provider} value={provider}>
			<HugeiconsIcon className="me-2 size-4" icon={ServerStack01Icon} />
			<span className="flex-1">{formatProviderName(provider)}</span>
			<SelectedTick visible={isSelected} />
			<span className="text-2xs text-foreground-muted">({count})</span>
		</Combobox.Item>
	);
}

export function renderProviderRow(provider: string, ctx: ItemContext) {
	if (provider === ALL_PROVIDERS_VALUE) {
		return renderAllProviders(
			ctx.selectedEndpointProvider === null,
			ctx.allLabel,
		);
	}
	const count = ctx.counts.get(provider) ?? 0;
	return renderProviderItem(
		provider,
		count,
		ctx.selectedEndpointProvider === provider,
	);
}

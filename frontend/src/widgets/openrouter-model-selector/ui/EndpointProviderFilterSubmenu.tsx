import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
	ALL_PROVIDERS_VALUE,
	applyProviderChange,
	filterEndpointProviders,
	type ItemContext,
	renderProviderRow,
	resolveComboboxValue,
} from "../lib/endpoint-provider-filter-submenu-test-helpers";
import { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "./DropdownMenu";

const PROVIDER_RENDER_LIMIT = 100;

export interface EndpointProviderFilterSubmenuProps {
	endpointProviders: [string, number][];
	onEndpointProviderSelect: (provider: string | null) => void;
	selectedEndpointProvider: string | null;
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

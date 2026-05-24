import { Combobox } from "@base-ui/react/combobox";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
	filterByQuery,
	type ItemContext,
	renderAuthorItem,
	SelectedCountBadge,
} from "../lib/author-filter-submenu-test-helpers";
import { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "./DropdownMenu";

const AUTHOR_RENDER_LIMIT = 100;

export interface AuthorFilterSubmenuProps {
	allProviders: string[];
	favoriteProviders: string[];
	onMakersChange: (makers: string[]) => void;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	selectedMakers: string[];
}

export function AuthorFilterSubmenu({
	allProviders,
	providerCounts,
	selectedMakers,
	favoriteProviders,
	onMakersChange,
	onToggleFavorite,
}: AuthorFilterSubmenuProps) {
	const [search, setSearch] = useState("");

	const favoritesSet = new Set(favoriteProviders);
	const selectedSet = new Set(selectedMakers);
	const queryLower = search.toLowerCase();
	const filtered = filterByQuery(allProviders, queryLower);

	const itemCtx: ItemContext = {
		favoritesSet,
		onToggleFavorite,
		providerCounts,
		selectedSet,
	};

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="me-2 size-4" icon={SparklesIcon} />
				<span>Model Author</span>
				<SelectedCountBadge count={selectedMakers.length} />
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-64 p-0">
				<Combobox.Root
					inline
					items={filtered}
					limit={AUTHOR_RENDER_LIMIT}
					multiple
					onInputValueChange={setSearch}
					onValueChange={(values: string[]) => onMakersChange(values)}
					open
					value={selectedMakers}
				>
					<div className="flex h-full flex-col">
						<div className="p-2">
							<Combobox.Input
								className="h-8 w-full rounded-sm border border-border bg-surface-tertiary px-2.5 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
								placeholder="Search authors"
							/>
						</div>
						<Combobox.Empty className="py-4 text-center text-body text-foreground-muted">
							No authors found.
						</Combobox.Empty>
						<Combobox.List className="h-64 overflow-y-auto">
							<Combobox.Collection>
								{(provider: string) => renderAuthorItem(provider, itemCtx)}
							</Combobox.Collection>
						</Combobox.List>
					</div>
				</Combobox.Root>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

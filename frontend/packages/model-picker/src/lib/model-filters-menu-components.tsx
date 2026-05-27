"use client";

import { AuthorFilterSubmenu } from "../ui/AuthorFilterSubmenu";
import { EndpointProviderFilterSubmenu } from "../ui/EndpointProviderFilterSubmenu";
import { shouldRenderAuthorSubmenu, shouldRenderEndpointSubmenu } from "./model-filters-menu-utils";

interface MaybeAuthorSubmenuProps {
	allProviders: string[];
	favoriteProviders: string[];
	onMakersChange?: ((makers: string[]) => void) | undefined;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	selectedMakers: string[];
}

export function MaybeAuthorSubmenu(props: MaybeAuthorSubmenuProps) {
	if (!shouldRenderAuthorSubmenu(props.allProviders, props.onMakersChange)) {
		return null;
	}
	return (
		<AuthorFilterSubmenu
			allProviders={props.allProviders}
			favoriteProviders={props.favoriteProviders}
			onMakersChange={props.onMakersChange as (makers: string[]) => void}
			onToggleFavorite={props.onToggleFavorite}
			providerCounts={props.providerCounts}
			selectedMakers={props.selectedMakers}
		/>
	);
}

interface MaybeEndpointSubmenuProps {
	endpointProviders: [string, number][];
	onEndpointProviderSelect: (provider: string | null) => void;
	selectedEndpointProvider: string | null;
}

export function MaybeEndpointSubmenu(props: MaybeEndpointSubmenuProps) {
	if (!shouldRenderEndpointSubmenu(props.endpointProviders)) {
		return null;
	}
	return (
		<EndpointProviderFilterSubmenu
			endpointProviders={props.endpointProviders}
			onEndpointProviderSelect={props.onEndpointProviderSelect}
			selectedEndpointProvider={props.selectedEndpointProvider}
		/>
	);
}

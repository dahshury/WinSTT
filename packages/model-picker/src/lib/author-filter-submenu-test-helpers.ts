import { SelectedCountBadge } from "./author-filter-submenu-components";
import { renderAuthorItem } from "./author-filter-submenu-render";
import {
	filterByQuery,
	getFavoriteTooltipText,
	handleFavoriteButtonClick,
	type ItemContext,
} from "./author-filter-submenu-utils";

export { filterByQuery, type ItemContext, renderAuthorItem, SelectedCountBadge };

export const __author_filter_submenu_test_helpers__ = {
	filterByQuery,
	getFavoriteTooltipText,
	handleFavoriteButtonClick,
	renderAuthorItem,
	SelectedCountBadge,
};

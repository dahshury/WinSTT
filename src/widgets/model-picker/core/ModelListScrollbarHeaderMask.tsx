import { GROUP_HEADER_SCROLLBAR_MASK_CLASSES } from "./model-card/card-constants";

export function ModelListScrollbarHeaderMask() {
	return (
		<span
			aria-hidden="true"
			className={GROUP_HEADER_SCROLLBAR_MASK_CLASSES}
			data-slot="model-list-scrollbar-header-mask"
		/>
	);
}

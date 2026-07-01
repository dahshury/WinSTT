import { StarIcon } from "@hugeicons/core-free-icons";
import { GroupHeader, NeutralHeaderIcon } from "../core/model-card/GroupHeader";
import { FAVORITES_SECTION_ID } from "./model-list-content-virtualized-utils/items";
import { MakerHeaderIcon } from "./model-list-model-header";

export function SectionHeader({
	count,
	label,
	sectionId,
}: {
	count: number;
	label: string;
	sectionId: string;
}) {
	const subtitle = `· ${count === 1 ? "1 model" : `${count} models`}`;
	return sectionId === FAVORITES_SECTION_ID ? (
		<GroupHeader
			data-rail-section={sectionId}
			icon={<NeutralHeaderIcon icon={StarIcon} tone="favorites" />}
			label={label}
			subtitle={subtitle}
		/>
	) : (
		<GroupHeader
			data-rail-section={sectionId}
			icon={<MakerHeaderIcon maker={sectionId} />}
			label={label}
			subtitle={subtitle}
		/>
	);
}

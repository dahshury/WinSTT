import { HardDriveDownloadIcon } from "@hugeicons/core-free-icons";
import type { MetaEntry } from "./CardMeta";

/** The download-size fact under a model name. The STT and TTS cards build the
 *  identical entry (hard-drive glyph + `Download size:` tooltip), so it lives
 *  here as one factory the adapters share. */
export function downloadSizeMetaEntry(bytes: string): MetaEntry {
	return {
		key: "size",
		icon: HardDriveDownloadIcon,
		value: bytes,
		tooltip: `Download size: ${bytes}`,
	};
}

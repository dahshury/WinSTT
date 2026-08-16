import { commands } from "@/bindings";

export type ShortcutBindingId =
	| "post_processing_profile_swap"
	| "read_aloud"
	| "repaste"
	| "transcribe"
	| "transforms";

/**
 * Ask the native shortcut registry to claim a binding's default before the
 * renderer mirrors that default into the WinSTT settings tree. The backend's
 * reset path is transactional: a collision leaves the previous binding armed.
 */
export async function claimDefaultShortcutBinding(
	id: ShortcutBindingId,
): Promise<void> {
	const result = await commands.resetBinding(id);
	if (result.status === "error") {
		throw new Error(String(result.error || "Shortcut reset failed"));
	}
	if (!result.data.success) {
		throw new Error(result.data.error ?? "Shortcut reset failed");
	}
}

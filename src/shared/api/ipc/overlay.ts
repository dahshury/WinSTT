import { commands, type OverlayHitRect, type Result } from "@/bindings";

export type { OverlayHitRect };

function unwrapResult<T>(result: Result<T, string>): T {
	if (result.status === "error") {
		throw new Error(result.error);
	}
	return result.data;
}

export async function setOverlayHitRegions(
	rects: OverlayHitRect[],
): Promise<void> {
	unwrapResult(await commands.setOverlayHitRegions(rects));
}

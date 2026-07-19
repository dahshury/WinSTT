import { use } from "react";
import { SurfaceContext } from "./surface-context";

export function useSurface(): number {
	return use(SurfaceContext);
}

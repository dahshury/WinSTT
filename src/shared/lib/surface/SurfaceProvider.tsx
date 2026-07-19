import { SurfaceContext } from "./surface-context";
import type { SurfaceProviderProps } from "./surface-provider.types";

export function SurfaceProvider({ value, children }: SurfaceProviderProps) {
	return (
		<SurfaceContext.Provider value={Math.max(1, Math.min(8, value))}>
			{children}
		</SurfaceContext.Provider>
	);
}

import * as React from "react";

const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export { useIsomorphicLayoutEffect };

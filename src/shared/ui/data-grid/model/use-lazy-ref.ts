import * as React from "react";

function useLazyRef<T>(fn: () => T): React.RefObject<T> {
	const ref = React.useRef<T | null>(null);
	if (ref.current === null) {
		// react-doctor-disable-next-line react-doctor/no-ref-current-in-render -- canonical null-guarded lazy-init (ref written once only when null); react-doctor documents this exact pattern as supported
		ref.current = fn();
	}
	return ref as React.RefObject<T>;
}

export { useLazyRef };

/** Continuously sweeping accent bar pinned to the parent's bottom edge.
 *  Requires the parent to be `position: relative` and `overflow: hidden`. */
export function SwapSweepBar() {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-accent/15"
		>
			<span className="block h-full w-1/2 animate-swap-sweep bg-gradient-to-r from-transparent via-accent to-transparent" />
		</span>
	);
}

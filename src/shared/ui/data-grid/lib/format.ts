export function formatDate(
	date: Date | string | number | undefined,
	opts: Intl.DateTimeFormatOptions = {},
) {
	if (!date) return "";

	try {
		// eslint-disable-next-line react-doctor/js-hoist-intl -- formatter options are derived per-call from the `opts` argument (month/day/year/...spread), so it cannot be hoisted to a single module-level constant without changing behavior
		return new Intl.DateTimeFormat("en-US", {
			month: opts.month ?? "long",
			day: opts.day ?? "numeric",
			year: opts.year ?? "numeric",
			...opts,
		}).format(new Date(date));
	} catch (_err) {
		return "";
	}
}

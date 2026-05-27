/** WinSTT is always dark-themed; resolves to "dark" unless overridden via prop. */
export function resolveAuraTheme(themeMode: "dark" | "light" | undefined): "dark" | "light" {
	// themeMode prop takes priority; otherwise always dark.
	return themeMode ?? "dark";
}

export function themeModeToUniform(theme: "dark" | "light"): number {
	return theme === "light" ? 1.0 : 0.0;
}

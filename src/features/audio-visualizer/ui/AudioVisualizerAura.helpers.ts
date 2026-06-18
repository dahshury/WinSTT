export type AuraShape = "circle" | "line";
export type AuraTheme = "dark" | "light";

export function resolveAuraTheme(
	themeMode: AuraTheme | undefined,
): AuraTheme {
	return themeMode ?? "dark";
}

export function themeModeToUniform(theme: AuraTheme): number {
	return theme === "light" ? 1.0 : 0.0;
}

export function auraShapeToUniform(shape: AuraShape | undefined): number {
	return shape === "line" ? 2.0 : 1.0;
}

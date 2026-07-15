export function isMissingModelId(parsedModelId: string | undefined): boolean {
	return parsedModelId === undefined || parsedModelId === "";
}

export function getTriggerDataState(open: boolean): "open" | "closed" {
	return open ? "open" : "closed";
}

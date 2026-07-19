import { commands } from "@/bindings";

/**
 * Run the configured post-processing LLM over a history entry's raw
 * transcript with the given instructions. The backend stores the result as
 * the entry's processed text (overwriting a previous run) and broadcasts the
 * standard history-updated events, so stores refresh themselves; the resolved
 * value is only needed for dialog feedback. Throws with the backend's message
 * on failure — callers surface it inline.
 */
export async function postProcessHistoryEntry(
	id: number,
	instructions: string,
): Promise<string> {
	const result = await commands.historyPostProcess(id, instructions);
	if (result.status === "error") {
		throw new Error(String(result.error));
	}
	return result.data;
}

import type { TranslateFn } from "./types";

const OLLAMA_LIBRARY_URL = "https://ollama.com/library";

export function DialogFooter({ t }: { t: TranslateFn }) {
	return (
		<div className="border-border border-t pt-3">
			<a
				className="inline-flex items-center gap-1.5 text-accent text-xs hover:underline"
				href={OLLAMA_LIBRARY_URL}
				rel="noreferrer"
				target="_blank"
			>
				{t("openLibrary")} -&gt;
			</a>
		</div>
	);
}

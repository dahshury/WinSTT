import { Cancel01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { onLlmLearnedProperNouns } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";

export interface AutoAddSuggestionsProps {
	/**
	 * Term values already present in the user's dictionary (vocab side).
	 * Used to filter incoming LLM suggestions so the user is never offered
	 * something they already accepted or wrote in by hand.
	 */
	existingTerms: readonly string[];
	/** Called when the user accepts a suggested noun — adds it as a vocab entry. */
	onAccept: (term: string) => void;
}

/**
 * Auto-Add proper-noun suggestion strip. Subscribes to the LLM cleanup
 * pipeline's `LLM_LEARNED_PROPER_NOUNS` broadcast and shows each pending
 * noun as a pill the user can Accept (✓ → adds to the dictionary) or
 * Decline (✗ → just drops the suggestion).
 *
 * Suggestions are kept ONLY in component-local state — accepting writes
 * to the dictionary store, declining forgets the suggestion. If the
 * model re-suggests a declined word on a future dictation it'll show up
 * again, which is the right behaviour: the user might have changed
 * their mind. (Persisting a "permanently dismissed" set is a future
 * refinement, not a Wispr-parity requirement.)
 *
 * Already-in-dictionary terms are filtered out on arrival so the strip
 * stays signal: the user only sees genuinely new candidates.
 */
export function AutoAddSuggestions({ existingTerms, onAccept }: AutoAddSuggestionsProps) {
	const t = useTranslations("dictionary");
	const [pending, setPending] = useState<readonly string[]>([]);

	useEffect(() => {
		const off = onLlmLearnedProperNouns(({ nouns }) => {
			setPending((prev) => {
				const existing = new Set([
					...prev.map((p) => p.toLowerCase()),
					...existingTerms.map((e) => e.toLowerCase()),
				]);
				const fresh: string[] = [];
				for (const raw of nouns) {
					const lower = raw.toLowerCase();
					if (existing.has(lower)) {
						continue;
					}
					existing.add(lower);
					fresh.push(raw);
				}
				if (fresh.length === 0) {
					return prev;
				}
				// Keep most-recent at the start; cap at 20 so a chatty model
				// can't fill the strip with stale candidates indefinitely.
				return [...fresh, ...prev].slice(0, 20);
			});
		});
		return off;
	}, [existingTerms]);

	const handleAccept = (term: string): void => {
		onAccept(term);
		setPending((prev) => prev.filter((p) => p !== term));
	};

	const handleDecline = (term: string): void => {
		setPending((prev) => prev.filter((p) => p !== term));
	};

	if (pending.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2 rounded border border-border bg-surface-tertiary p-3">
			<div className="flex items-center gap-2">
				<span aria-hidden="true">✨</span>
				<p className="font-medium text-body-sm text-foreground">{t("autoAddTitle")}</p>
			</div>
			<p className="text-body-xs text-foreground-muted">{t("autoAddCaption")}</p>
			<div className="flex flex-wrap gap-2">
				{pending.map((term) => (
					<div
						className="flex items-center gap-1 rounded-full border border-border bg-surface-secondary px-2 py-1"
						key={term}
					>
						<span className="text-body-sm text-foreground">{term}</span>
						<Button
							aria-label={`${t("autoAddAccept")} "${term}"`}
							className="rounded-full bg-transparent p-1 text-success transition-colors duration-150 hover:bg-success-dim"
							onClick={() => handleAccept(term)}
						>
							<HugeiconsIcon icon={Tick01Icon} size={12} />
						</Button>
						<Button
							aria-label={`${t("autoAddDecline")} "${term}"`}
							className="rounded-full bg-transparent p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-secondary"
							onClick={() => handleDecline(term)}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}

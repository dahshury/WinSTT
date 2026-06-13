import {
	Cancel01Icon,
	SparklesIcon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { onLlmLearnedProperNouns } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { normalizeDictionaryTerm } from "../lib/dictionary-terms";

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
export function AutoAddSuggestions({
	existingTerms,
	onAccept,
}: AutoAddSuggestionsProps) {
	const t = useTranslations("dictionary");
	const [pending, setPending] = useState<readonly string[]>([]);

	useEffect(() => {
		const off = onLlmLearnedProperNouns(({ nouns }) => {
			setPending((prev) => {
				const existing = new Set([
					...prev.map(normalizeDictionaryTerm),
					...existingTerms.map(normalizeDictionaryTerm),
				]);
				const fresh: string[] = [];
				for (const raw of nouns) {
					const term = raw.trim();
					const normalized = normalizeDictionaryTerm(term);
					if (!normalized || existing.has(normalized)) {
						continue;
					}
					existing.add(normalized);
					fresh.push(term);
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
		<div className="flex animate-fade-in flex-col gap-2.5 rounded-lg bg-accent-glow p-3 shadow-surface-2 ring-1 ring-accent/20">
			<div className="flex items-center gap-2">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent ring-1 ring-accent/25">
					<HugeiconsIcon aria-hidden="true" icon={SparklesIcon} size={13} />
				</span>
				<p className="font-medium text-body-sm text-foreground">
					{t("autoAddTitle")}
				</p>
				<InfoTooltip content={t("autoAddCaption")} />
			</div>
			<div className="flex flex-wrap gap-1.5">
				{pending.map((term, index) => (
					<div
						className="flex animate-fade-in items-center gap-0.5 rounded-full bg-surface-5/70 py-0.5 pr-1 pl-2.5 shadow-surface-1 ring-1 ring-divider/70"
						key={term}
						style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
					>
						<span className="text-body-sm text-foreground">{term}</span>
						<Button
							aria-label={`${t("autoAddAccept")} "${term}"`}
							className="rounded-full p-1 text-success transition-colors duration-150 hover:bg-success-dim"
							onClick={() => handleAccept(term)}
						>
							<HugeiconsIcon icon={Tick01Icon} size={12} />
						</Button>
						<Button
							aria-label={`${t("autoAddDecline")} "${term}"`}
							className="rounded-full p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-6/80 hover:text-foreground"
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

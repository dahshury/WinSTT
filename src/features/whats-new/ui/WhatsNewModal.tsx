import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import {
	releaseNotesForVersion,
	writeLastSeenVersion,
} from "@/features/whats-new/model/release-notes";
import {
	Dialog,
	DialogActionButton,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
} from "@/shared/ui/dialog";

interface ActiveReleaseNotes {
	notes: string;
	version: string;
}

interface KeyedText {
	key: string;
	text: string;
}

function keyTextOccurrences(texts: readonly string[]): KeyedText[] {
	const occurrences = new Map<string, number>();
	return texts.map((text) => {
		const occurrence = occurrences.get(text) ?? 0;
		occurrences.set(text, occurrence + 1);
		return { key: `${text}\u0000${occurrence}`, text };
	});
}

function parseMarkdownBlocks(notes: string): KeyedText[] {
	const occurrences = new Map<string, number>();
	const blocks: KeyedText[] = [];
	for (const rawBlock of notes.trim().split(/\n\s*\n/)) {
		const text = rawBlock.trim();
		if (!text) {
			continue;
		}
		const occurrence = occurrences.get(text) ?? 0;
		occurrences.set(text, occurrence + 1);
		blocks.push({ key: `${text}\u0000${occurrence}`, text });
	}
	return blocks;
}

function renderInlineMarkdown(text: string): ReactNode {
	const pieces = keyTextOccurrences(text.split(/(`[^`]+`)/g));
	return pieces.map((piece) =>
		piece.text.startsWith("`") && piece.text.endsWith("`") ? (
			<code
				className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-foreground"
				key={piece.key}
			>
				{piece.text.slice(1, -1)}
			</code>
		) : (
			<Fragment key={piece.key}>{piece.text}</Fragment>
		),
	);
}

function MarkdownReleaseNotes({ notes }: { notes: string }) {
	const blocks = parseMarkdownBlocks(notes);

	return (
		<div className="space-y-3">
			{blocks.map((block) => {
				if (block.text.startsWith("# ")) {
					return (
						<h2
							className="font-semibold text-lg text-foreground tracking-tight"
							key={block.key}
						>
							{renderInlineMarkdown(block.text.slice(2))}
						</h2>
					);
				}
				if (block.text.startsWith("## ")) {
					return (
						<h3
							className="pt-1 font-semibold text-body text-foreground"
							key={block.key}
						>
							{renderInlineMarkdown(block.text.slice(3))}
						</h3>
					);
				}
				if (block.text.startsWith("- ")) {
					return (
						<ul
							className="space-y-1.5 pl-4 text-body text-foreground-secondary leading-relaxed"
							key={block.key}
						>
							{keyTextOccurrences(block.text.split("\n")).map((item) => (
								<li className="list-disc pl-0.5" key={item.key}>
									{renderInlineMarkdown(item.text.replace(/^-\s+/, ""))}
								</li>
							))}
						</ul>
					);
				}
				return (
					<p
						className="text-body text-foreground-secondary leading-relaxed"
						key={block.key}
					>
						{renderInlineMarkdown(block.text.replaceAll("\n", " "))}
					</p>
				);
			})}
		</div>
	);
}

/** Full-size release-note surface rendered by the dedicated native window. */
export function WhatsNewWindow() {
	const [active, setActive] = useState<ActiveReleaseNotes | null>(null);
	const common = useTranslations("common");

	useEffect(() => {
		let cancelled = false;
		commands
			.aboutGetAppInfo()
			.then(({ version }) => {
				if (cancelled) {
					return;
				}
				const notes = releaseNotesForVersion(version);
				if (notes) {
					// Reaching this point means the dedicated window loaded the release
					// successfully. Mark it seen now so Alt+F4 and process shutdown cannot
					// make the same notes reappear on the next launch.
					writeLastSeenVersion(version);
					setActive({ notes, version });
					return;
				}
				void commands.closeSelfWindow();
			})
			.catch(() => {
				void commands.closeSelfWindow();
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const close = () => {
		setActive(null);
		void commands.closeSelfWindow();
	};

	return (
		<Dialog onOpenChange={(open) => !open && close()} open={active !== null}>
			<DialogContent
				className="flex h-[min(680px,calc(100vh-2rem))] w-[min(640px,calc(100vw-2rem))] flex-col"
				fluid
				padded={false}
			>
				{/* Was a hand-rolled header/footer band; now the shared rails, so this
				    window picks up the same chrome tint and hairlines as every other
				    dialog. */}
				<DialogHeader
					closeLabel={common("close")}
					icon={<HugeiconsIcon icon={SparklesIcon} size={15} />}
					onClose={close}
					rail
					title={active ? `WinSTT ${active.version}` : "WinSTT"}
				/>
				<DialogBody className="flex-1" maxHeight="none">
					{active ? <MarkdownReleaseNotes notes={active.notes} /> : null}
				</DialogBody>
				<DialogFooter bar>
					<DialogActionButton onClick={close} variant="accent">
						{common("close")}
					</DialogActionButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

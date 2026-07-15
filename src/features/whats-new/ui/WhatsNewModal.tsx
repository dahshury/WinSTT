import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import {
	releaseNotesForVersion,
	writeLastSeenVersion,
} from "@/features/whats-new/model/release-notes";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogHeader } from "@/shared/ui/dialog";

interface ActiveReleaseNotes {
	notes: string;
	version: string;
}

function renderInlineMarkdown(text: string): ReactNode {
	const pieces = text.split(/(`[^`]+`)/g);
	return pieces.map((piece, index) =>
		piece.startsWith("`") && piece.endsWith("`") ? (
			<code
				className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-foreground"
				key={`${piece}-${index}`}
			>
				{piece.slice(1, -1)}
			</code>
		) : (
			<Fragment key={`${piece}-${index}`}>{piece}</Fragment>
		),
	);
}

function MarkdownReleaseNotes({ notes }: { notes: string }) {
	const blocks = notes
		.trim()
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean);

	return (
		<div className="space-y-3">
			{blocks.map((block, index) => {
				if (block.startsWith("# ")) {
					return (
						<h2
							className="font-semibold text-lg text-foreground tracking-tight"
							key={`${block}-${index}`}
						>
							{renderInlineMarkdown(block.slice(2))}
						</h2>
					);
				}
				if (block.startsWith("## ")) {
					return (
						<h3
							className="pt-1 font-semibold text-body text-foreground"
							key={`${block}-${index}`}
						>
							{renderInlineMarkdown(block.slice(3))}
						</h3>
					);
				}
				if (block.startsWith("- ")) {
					return (
						<ul
							className="space-y-1.5 pl-4 text-body text-foreground-secondary leading-relaxed"
							key={`${block}-${index}`}
						>
							{block.split("\n").map((item) => (
								<li className="list-disc pl-0.5" key={item}>
									{renderInlineMarkdown(item.replace(/^-\s+/, ""))}
								</li>
							))}
						</ul>
					);
				}
				return (
					<p
						className="text-body text-foreground-secondary leading-relaxed"
						key={`${block}-${index}`}
					>
						{renderInlineMarkdown(block.replaceAll("\n", " "))}
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
				<div className="border-divider border-b px-5 py-4">
					<DialogHeader
						closeLabel={common("close")}
						icon={<HugeiconsIcon icon={SparklesIcon} size={17} />}
						onClose={close}
						title={active ? `WinSTT ${active.version}` : "WinSTT"}
					/>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
					{active ? <MarkdownReleaseNotes notes={active.notes} /> : null}
				</div>
				<div className="flex justify-end border-divider border-t px-5 py-3">
					<Button
						className="h-8 rounded-md bg-accent px-4 font-medium text-body text-on-accent hover:bg-accent-hover"
						onClick={close}
					>
						{common("close")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

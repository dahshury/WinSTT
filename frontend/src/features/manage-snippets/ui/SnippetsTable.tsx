"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { components } from "@spec/schema";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type AddSnippetEntry, addSnippetEntrySchema } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { FormControl } from "@/shared/ui/form-control";
import { TextField } from "@/shared/ui/text-field";

type SnippetEntry = components["schemas"]["SnippetEntry"];

export interface SnippetsTableProps {
	entries: SnippetEntry[];
	onAdd: (entry: Omit<SnippetEntry, "id">) => void;
	onRemove: (id: string) => void;
	onClearAll?: () => void;
}

export function SnippetsTable({ entries, onAdd, onRemove, onClearAll }: SnippetsTableProps) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const {
		register,
		handleSubmit,
		reset,
		watch,
		formState: { errors },
	} = useForm<AddSnippetEntry>({
		resolver: zodResolver(addSnippetEntrySchema),
		defaultValues: { trigger: "", expansion: "" },
	});

	const triggerValue = watch("trigger");
	const expansionValue = watch("expansion");

	const onSubmit = (data: AddSnippetEntry) => {
		onAdd({ trigger: data.trigger.trim(), expansion: data.expansion.trim() });
		reset();
	};

	const triggerReg = register("trigger");
	const expansionReg = register("expansion");
	const isAddDisabled = !(triggerValue?.trim() && expansionValue?.trim());

	return (
		<div className="flex flex-col gap-3">
			<form className="flex items-end gap-2" onSubmit={handleSubmit(onSubmit)}>
				<div className="w-1/3">
					<FormControl error={errors.trigger?.message} label="Trigger">
						<TextField
							error={!!errors.trigger}
							name={triggerReg.name}
							onBlur={triggerReg.onBlur}
							onChange={triggerReg.onChange}
							placeholder="Trigger..."
							ref={triggerReg.ref}
						/>
					</FormControl>
				</div>
				<div className="flex-1">
					<FormControl error={errors.expansion?.message} label="Expansion">
						<TextField
							error={!!errors.expansion}
							name={expansionReg.name}
							onBlur={expansionReg.onBlur}
							onChange={expansionReg.onChange}
							placeholder="Expands to..."
							ref={expansionReg.ref}
						/>
					</FormControl>
				</div>
				<Button
					className="h-8 rounded-md bg-accent px-3 font-medium text-[13px] text-black transition-colors duration-150 hover:bg-accent-hover"
					disabled={isAddDisabled}
					type="submit"
				>
					Add
				</Button>
			</form>
			<div className="flex flex-col gap-1">
				{entries.map((entry) => (
					<div
						className="flex items-center justify-between rounded border border-border bg-surface-tertiary px-3 py-2 text-[13px]"
						key={entry.id}
					>
						<span>
							<span className="text-accent">{entry.trigger}</span>
							<span className="text-foreground-muted">{" → "}</span>
							<span className="text-foreground">{entry.expansion}</span>
						</span>
						<Button
							className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
							onClick={() => onRemove(entry.id)}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
						</Button>
					</div>
				))}
				{entries.length === 0 && (
					<p className="py-4 text-center text-[13px] text-foreground-muted">No snippets yet</p>
				)}
			</div>
			{onClearAll && (
				<>
					<ConfirmDialog
						description="All snippets will be permanently removed. This cannot be undone."
						onConfirm={onClearAll}
						onOpenChange={setClearConfirmOpen}
						open={clearConfirmOpen}
						title="Delete All Snippets?"
					/>
					<Button
						className="h-7 self-end rounded-md border border-error bg-transparent px-2.5 font-medium text-error text-xs transition-colors duration-150 hover:bg-error-dim"
						disabled={entries.length === 0}
						onClick={() => setClearConfirmOpen(true)}
					>
						Delete All
					</Button>
				</>
			)}
		</div>
	);
}

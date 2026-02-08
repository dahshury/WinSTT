"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { components } from "@spec/schema";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type AddDictionaryEntry, addDictionaryEntrySchema } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { FormControl } from "@/shared/ui/form-control";
import { TextField } from "@/shared/ui/text-field";

type DictionaryEntry = components["schemas"]["DictionaryEntry"];

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, entry: Partial<DictionaryEntry>) => void;
	onClearAll?: () => void;
}

export function DictionaryTable({ entries, onAdd, onRemove, onClearAll }: DictionaryTableProps) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const {
		register,
		handleSubmit,
		reset,
		watch,
		formState: { errors },
	} = useForm<AddDictionaryEntry>({
		resolver: zodResolver(addDictionaryEntrySchema),
		defaultValues: { find: "", replace: "", caseSensitive: false, wholeWord: false },
	});

	const findValue = watch("find");
	const replaceValue = watch("replace");

	const onSubmit = (data: AddDictionaryEntry) => {
		onAdd({
			find: data.find.trim(),
			replace: data.replace.trim(),
			caseSensitive: data.caseSensitive,
			wholeWord: data.wholeWord,
		});
		reset();
	};

	const findReg = register("find");
	const replaceReg = register("replace");
	const isAddDisabled = !(findValue?.trim() && replaceValue?.trim());

	return (
		<div className="flex flex-col gap-3">
			<form className="flex items-end gap-2" onSubmit={handleSubmit(onSubmit)}>
				<div className="flex-1">
					<FormControl error={errors.find?.message} label="Find">
						<TextField
							error={!!errors.find}
							name={findReg.name}
							onBlur={findReg.onBlur}
							onChange={findReg.onChange}
							placeholder="Find..."
							ref={findReg.ref}
						/>
					</FormControl>
				</div>
				<div className="flex-1">
					<FormControl error={errors.replace?.message} label="Replace">
						<TextField
							error={!!errors.replace}
							name={replaceReg.name}
							onBlur={replaceReg.onBlur}
							onChange={replaceReg.onChange}
							placeholder="Replace with..."
							ref={replaceReg.ref}
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
							<span className="text-foreground-secondary">{entry.find}</span>
							<span className="text-foreground-muted">{" → "}</span>
							<span className="text-foreground">{entry.replace}</span>
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
					<p className="py-4 text-center text-[13px] text-foreground-muted">
						No dictionary entries yet
					</p>
				)}
			</div>
			{onClearAll && (
				<>
					<ConfirmDialog
						description="All dictionary entries will be permanently removed. This cannot be undone."
						onConfirm={onClearAll}
						onOpenChange={setClearConfirmOpen}
						open={clearConfirmOpen}
						title="Delete All Dictionary Entries?"
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

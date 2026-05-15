"use client";

import {
	AiBrain02Icon,
	Delete02Icon,
	KeyboardIcon,
	PlayIcon,
	PlusSignIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { components } from "@spec/schema";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { previewTransform } from "@/shared/api/ipc-client";
import { BUILTIN_TRANSFORMS } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { TextField } from "@/shared/ui/text-field";

type Transform = components["schemas"]["Transform"];

function genId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug || "custom"}-${Date.now().toString(36)}`;
}

/**
 * Look up a built-in's default prompt by id. Used by the "Reset" action so
 * users can revert an accidentally-edited built-in transform without
 * triggering a full settings reset.
 */
function findBuiltinDefault(id: string): Transform | undefined {
	const found = BUILTIN_TRANSFORMS.find((b) => b.id === id);
	if (!found) {
		return;
	}
	return {
		id: found.id,
		name: found.name,
		prompt: found.prompt ?? "",
		hotkey: found.hotkey ?? "",
		builtin: true,
	};
}

interface TransformRowProps {
	expanded: boolean;
	onChange: (patch: Partial<Transform>) => void;
	onDelete: () => void;
	onReset: () => void;
	onToggle: () => void;
	transform: Transform;
}

function TransformRow({
	transform,
	expanded,
	onToggle,
	onChange,
	onDelete,
	onReset,
}: TransformRowProps) {
	const t = useTranslations("llm");
	return (
		<div className="rounded-md border border-border bg-surface">
			<div className="flex items-center gap-2 p-3">
				<button
					aria-expanded={expanded}
					className="flex flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					type="button"
				>
					<HugeiconsIcon className="text-foreground-muted" icon={AiBrain02Icon} size={16} />
					<span className="font-medium text-body">{transform.name || t("transformUnnamed")}</span>
					{transform.builtin ? (
						<span className="rounded bg-surface-tertiary px-1.5 py-0.5 font-mono text-foreground-muted text-xs">
							{t("transformBuiltin")}
						</span>
					) : null}
					{transform.hotkey ? (
						<span className="ml-2 flex items-center gap-1 rounded bg-surface-tertiary px-2 py-0.5 font-mono text-foreground-muted text-xs">
							<HugeiconsIcon icon={KeyboardIcon} size={11} />
							{transform.hotkey}
						</span>
					) : null}
				</button>
				{transform.builtin ? (
					<Button
						aria-label={t("transformReset")}
						className="rounded p-1 text-foreground-muted hover:bg-surface-tertiary hover:text-foreground"
						onClick={onReset}
					>
						<HugeiconsIcon icon={RefreshIcon} size={14} />
					</Button>
				) : (
					<Button
						aria-label={t("transformDelete")}
						className="rounded p-1 text-foreground-muted hover:bg-error hover:text-white"
						onClick={onDelete}
					>
						<HugeiconsIcon icon={Delete02Icon} size={14} />
					</Button>
				)}
			</div>
			{expanded ? (
				<div className="flex flex-col gap-3 border-border border-t p-3">
					{transform.builtin ? null : (
						// biome-ignore lint/a11y/noLabelWithoutControl: label wraps TextField (custom input wrapper); biome can't see the nested <input>
						<label className="flex flex-col gap-1">
							<span className="text-foreground-muted text-xs uppercase tracking-wide">
								{t("transformName")}
							</span>
							<TextField
								onChange={(e) => onChange({ name: e.target.value })}
								value={transform.name}
							/>
						</label>
					)}
					<label className="flex flex-col gap-1">
						<span className="text-foreground-muted text-xs uppercase tracking-wide">
							{t("transformPrompt")}
						</span>
						<textarea
							className="min-h-[120px] w-full resize-y rounded border border-border bg-background p-2 font-mono text-body text-foreground outline-none transition-colors focus:border-accent"
							onChange={(e) => onChange({ prompt: e.target.value })}
							placeholder={t("transformPromptPlaceholder")}
							value={transform.prompt}
						/>
						<span className="text-foreground-muted text-xs">{t("transformPromptHint")}</span>
					</label>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: label wraps TextField (custom input wrapper); biome can't see the nested <input> */}
					<label className="flex flex-col gap-1">
						<span className="text-foreground-muted text-xs uppercase tracking-wide">
							{t("transformHotkey")}
						</span>
						<TextField
							onChange={(e) => onChange({ hotkey: e.target.value })}
							placeholder="LCtrl+LShift+P"
							value={transform.hotkey ?? ""}
						/>
						<span className="text-foreground-muted text-xs">{t("transformHotkeyHint")}</span>
					</label>
				</div>
			) : null}
		</div>
	);
}

interface PlaygroundProps {
	initialPrompt: string;
}

function TransformPlayground({ initialPrompt }: PlaygroundProps) {
	const t = useTranslations("llm");
	const [prompt, setPrompt] = useState(initialPrompt);
	const [sample, setSample] = useState("");
	const [output, setOutput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);

	const canRun = !running && prompt.trim().length > 0 && sample.trim().length > 0;

	const handleRun = async () => {
		setError(null);
		setOutput("");
		setRunning(true);
		try {
			const result = await previewTransform(sample, prompt);
			setOutput(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRunning(false);
		}
	};

	return (
		<div className="mt-4 rounded-md border border-border bg-surface-secondary p-4">
			<div className="mb-3 flex items-center gap-2">
				<HugeiconsIcon className="text-accent" icon={PlayIcon} size={16} />
				<span className="font-medium text-body">{t("transformPlaygroundTitle")}</span>
				<span className="ml-auto text-foreground-muted text-xs">
					{t("transformPlaygroundHint")}
				</span>
			</div>
			<div className="grid gap-3 md:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-foreground-muted text-xs uppercase tracking-wide">
						{t("transformPlaygroundPrompt")}
					</span>
					<textarea
						className="min-h-[140px] w-full resize-y rounded border border-border bg-background p-2 font-mono text-body text-foreground outline-none transition-colors focus:border-accent"
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={t("transformPlaygroundPromptPlaceholder")}
						value={prompt}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-foreground-muted text-xs uppercase tracking-wide">
						{t("transformPlaygroundSample")}
					</span>
					<textarea
						className="min-h-[140px] w-full resize-y rounded border border-border bg-background p-2 text-body text-foreground outline-none transition-colors focus:border-accent"
						onChange={(e) => setSample(e.target.value)}
						placeholder={t("transformPlaygroundSamplePlaceholder")}
						value={sample}
					/>
				</label>
			</div>
			<div className="mt-3 flex items-center gap-3">
				<Button
					className="flex items-center gap-1 rounded-md bg-accent px-4 py-2 font-medium text-body text-white transition-colors hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
					disabled={!canRun}
					onClick={handleRun}
				>
					<HugeiconsIcon icon={PlayIcon} size={14} />
					{running ? t("transformPlaygroundRunning") : t("transformPlaygroundRun")}
				</Button>
				{error ? <span className="text-error text-xs">{error}</span> : null}
			</div>
			<label className="mt-3 flex flex-col gap-1">
				<span className="text-foreground-muted text-xs uppercase tracking-wide">
					{t("transformPlaygroundOutput")}
				</span>
				<textarea
					className="min-h-[120px] w-full resize-y rounded border border-border bg-surface p-2 text-body text-foreground outline-none"
					readOnly={true}
					value={output}
				/>
			</label>
		</div>
	);
}

/**
 * Top-level Transforms management UI. Lives in the LLM tab as a sibling
 * SettingSection. Renders the editable list of transforms, a "+" button
 * to add custom ones, and the playground.
 */
export function TransformsSection() {
	const llm = useSettingsStore((s) => s.settings.llm);
	const update = useSettingsStore((s) => s.updateLlmSettings);
	const t = useTranslations("llm");
	const transforms: Transform[] = (llm?.transforms ?? []) as Transform[];
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const patchTransform = (id: string, patch: Partial<Transform>): void => {
		const next = transforms.map((tx) => (tx.id === id ? { ...tx, ...patch } : tx));
		update({ transforms: next });
	};

	const handleAdd = (): void => {
		const id = genId("custom");
		const fresh: Transform = {
			id,
			name: t("transformNewName"),
			prompt: "",
			hotkey: "",
			builtin: false,
		};
		update({ transforms: [...transforms, fresh] });
		setExpandedId(id);
	};

	const handleDelete = (id: string): void => {
		update({ transforms: transforms.filter((tx) => tx.id !== id) });
		if (expandedId === id) {
			setExpandedId(null);
		}
	};

	const handleReset = (id: string): void => {
		const base = findBuiltinDefault(id);
		if (!base) {
			return;
		}
		patchTransform(id, { name: base.name, prompt: base.prompt });
	};

	const playgroundSeed =
		transforms.find((tx) => tx.id === expandedId)?.prompt ?? transforms[0]?.prompt ?? "";

	return (
		<SettingSection icon={AiBrain02Icon} title={t("transformsTitle")}>
			<div className="flex flex-col gap-2 py-2">
				<p className="text-foreground-muted text-sm">{t("transformsCaption")}</p>
				<div className="flex flex-col gap-2">
					{transforms.map((tx) => (
						<TransformRow
							expanded={expandedId === tx.id}
							key={tx.id}
							onChange={(patch) => patchTransform(tx.id, patch)}
							onDelete={() => handleDelete(tx.id)}
							onReset={() => handleReset(tx.id)}
							onToggle={() => setExpandedId(expandedId === tx.id ? null : tx.id)}
							transform={tx}
						/>
					))}
				</div>
				<Button
					className="mt-2 flex items-center gap-1 self-start rounded-md border border-border border-dashed bg-transparent px-3 py-2 text-foreground-muted text-sm transition-colors hover:border-accent hover:text-accent"
					onClick={handleAdd}
				>
					<HugeiconsIcon icon={PlusSignIcon} size={14} />
					{t("transformAdd")}
				</Button>
				<TransformPlayground initialPrompt={playgroundSeed} />
			</div>
		</SettingSection>
	);
}

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	useSettingsStore,
} from "@/entities/setting";
import { type ContextAppEntry, listContextApps } from "@/shared/api/ipc-client";
import {
	SurfaceProvider,
	surfaceClasses,
	useSurface,
} from "@/shared/lib/surface";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import "@/shared/ui/searchable-select/searchable-select.css";

interface ContextAppOption {
	exe: string;
	icon?: string | null;
	id: string;
	label: string;
	title?: string | null;
}

function normalizeAppId(value: string): string {
	return value.trim().toLowerCase();
}

function uniqueNormalized(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const id = normalizeAppId(value);
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

function toOption(app: ContextAppEntry): ContextAppOption | null {
	const id = normalizeAppId(app.exe || app.id);
	if (!id) {
		return null;
	}
	return {
		id,
		exe: id,
		label: app.label || id,
		title: app.title ?? null,
		icon: app.icon ?? null,
	};
}

function buildOptions(
	apps: readonly ContextAppEntry[],
	selectedValues: readonly string[],
): ContextAppOption[] {
	const byId = new Map<string, ContextAppOption>();
	for (const app of apps) {
		const option = toOption(app);
		if (option) {
			byId.set(option.id, option);
		}
	}
	for (const raw of selectedValues) {
		const id = normalizeAppId(raw);
		if (id && !byId.has(id)) {
			byId.set(id, {
				id,
				exe: id,
				label: id,
				title: null,
				icon: null,
			});
		}
	}
	return [...byId.values()].toSorted((a, b) =>
		a.label
			.toLowerCase()
			.localeCompare(b.label.toLowerCase(), undefined, { sensitivity: "base" }),
	);
}

function optionMatches(option: ContextAppOption, query: string): boolean {
	return matchesFuzzySearch(
		[option.label, option.exe, option.title ?? ""],
		query,
	);
}

function summarizeSelection(
	options: readonly ContextAppOption[],
	value: readonly string[],
	placeholder: string,
): string {
	if (value.length === 0) {
		return placeholder;
	}
	const labels = value.map(
		(id) => options.find((option) => option.id === id)?.label ?? id,
	);
	if (labels.length <= 2) {
		return labels.join(", ");
	}
	return `${labels.length} apps selected`;
}

function AppIcon({ icon, label }: { icon?: string | null; label: string }) {
	if (icon) {
		return (
			<img
				alt=""
				className="size-4 rounded-[3px] object-contain"
				draggable={false}
				src={icon}
			/>
		);
	}
	return (
		<span className="flex size-4 items-center justify-center rounded-[3px] border border-border bg-surface-1 font-semibold text-[10px] text-foreground-muted uppercase">
			{label.trim().charAt(0) || "?"}
		</span>
	);
}

interface ContextAppsComboboxProps {
	ariaLabel: string;
	emptyLabel: string;
	errorLabel: string;
	initialOpen?: boolean | undefined;
	loadingLabel: string;
	onChange: (value: string[]) => void;
	placeholder: string;
	value: readonly string[];
}

interface AppsLoadState {
	apps: ContextAppEntry[];
	status: "idle" | "loading" | "loaded" | "error";
}

function ContextAppsCombobox({
	ariaLabel,
	emptyLabel,
	errorLabel,
	initialOpen = false,
	loadingLabel,
	onChange,
	placeholder,
	value,
}: ContextAppsComboboxProps) {
	const [open, setOpen] = useState(initialOpen);
	const [query, setQuery] = useState("");
	const [appsState, setAppsState] = useState<AppsLoadState>(() => ({
		apps: [],
		status: initialOpen ? "loading" : "idle",
	}));
	const apps = appsState.apps;
	const loading = open && appsState.status === "loading";
	const normalizedValue = uniqueNormalized(value);
	const options = buildOptions(apps, normalizedValue);
	const selected = new Set(normalizedValue);
	const visibleOptions = options.filter((option) =>
		optionMatches(option, query),
	);
	const checkedIndices = new Set<number>();
	visibleOptions.forEach((option, index) => {
		if (selected.has(option.id)) {
			checkedIndices.add(index);
		}
	});

	useEffect(() => {
		if (!open || appsState.status !== "loading") {
			return;
		}
		let cancelled = false;
		listContextApps()
			.then((next) => {
				if (!cancelled) {
					setAppsState({ apps: next, status: "loaded" });
				}
			})
			.catch((error) => {
				if (!cancelled) {
					// Distinguish a failed listing from a genuinely empty app list —
					// collapsing both into "loaded with no apps" hides the failure.
					console.error("[context-apps] listContextApps failed:", error);
					setAppsState({ apps: [], status: "error" });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [appsState.status, open]);

	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const closedDisplay = summarizeSelection(
		options,
		normalizedValue,
		placeholder,
	);

	const toggleOption = (id: string): void => {
		const next = selected.has(id)
			? normalizedValue.filter((candidate) => candidate !== id)
			: [...normalizedValue, id];
		onChange(next);
	};

	const openCombobox = (): void => {
		setOpen(true);
		setAppsState((current) =>
			current.status === "loading"
				? current
				: { apps: current.apps, status: "loading" },
		);
	};

	return (
		<Combobox.Root
			filter={null}
			inputValue={open ? query : closedDisplay}
			items={[]}
			onInputValueChange={setQuery}
			onOpenChange={(next) => {
				if (next) {
					openCombobox();
				} else {
					setOpen(false);
					setQuery("");
				}
			}}
			open={open}
			value={null}
		>
			<div className="relative isolate flex w-full items-center">
				<Combobox.Input
					aria-label={ariaLabel}
					className={`flex h-8 w-full items-center rounded-lg ${surfaceClasses(inputLevel)} pr-7 pl-2.5 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1`}
					onClick={openCombobox}
					placeholder={placeholder}
				/>
				<Combobox.Trigger
					aria-label="Open popup"
					className="absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
				>
					<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
				</Combobox.Trigger>
			</div>

			<Combobox.Portal>
				<SurfaceProvider value={popupLevel}>
					<Combobox.Positioner
						className="z-popover outline-none"
						collisionPadding={8}
						sideOffset={4}
					>
						<Combobox.Popup
							className={`searchable-select-popup relative w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(16rem,var(--available-height))]`}
						>
							{visibleOptions.length === 0 ? (
								<div
									className={`px-2.5 py-2 text-body-sm ${appsState.status === "error" ? "text-error" : "text-foreground-muted"}`}
								>
									{loading
										? loadingLabel
										: appsState.status === "error"
											? errorLabel
											: emptyLabel}
								</div>
							) : (
								<CheckboxGroup
									checkedIndices={checkedIndices}
									className="w-full px-1"
								>
									{visibleOptions.map((option, index) => {
										const checked = selected.has(option.id);
										return (
											<CheckboxItem
												checked={checked}
												index={index}
												key={option.id}
												label={option.label}
												leading={
													<AppIcon
														icon={option.icon ?? null}
														label={option.label}
													/>
												}
												onToggle={() => toggleOption(option.id)}
												trailing={
													<span className="max-w-[8rem] truncate font-mono text-[11px] text-foreground-muted">
														{option.exe}
													</span>
												}
											/>
										);
									})}
								</CheckboxGroup>
							)}
						</Combobox.Popup>
					</Combobox.Positioner>
				</SurfaceProvider>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

export function ContextAllowedAppsSection({
	initialOpen,
}: {
	initialOpen?: boolean | undefined;
}) {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const allowList = uniqueNormalized(general?.contextAllowList ?? []);
	const defaultAllowList = DEFAULT_SETTINGS.general.contextAllowList;
	const isDefaultAllowList =
		allowList.toSorted().join(" ") === defaultAllowList.toSorted().join(" ");

	return (
		<SettingField
			isDefault={isDefaultAllowList}
			label="Allowed apps"
			onReset={() => update({ contextAllowList: [...defaultAllowList] })}
			tooltip="Only selected apps are read for context. Open the combobox to choose from currently running apps."
		>
			<ContextAppsCombobox
				ariaLabel="Allowed apps"
				emptyLabel="No running apps found."
				errorLabel="Failed to list running apps."
				initialOpen={initialOpen}
				loadingLabel="Loading apps..."
				// In Allow-list mode context awareness only functions with ≥1 app, so
				// the allow-list IS the on/off switch here: persist the feature on when
				// the list has entries, off when it empties. This keeps the toggle (and
				// the backend) honest instead of leaving a captures-nothing state "on".
				onChange={(next) =>
					update({ contextAllowList: next, contextAwareness: next.length > 0 })
				}
				placeholder="Choose running apps..."
				value={allowList}
			/>
		</SettingField>
	);
}

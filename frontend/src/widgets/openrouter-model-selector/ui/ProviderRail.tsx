import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { formatMaker } from "../lib/model-selector-utils";
import { getProviderIconWithFallback } from "../lib/provider-icons";
import {
	applyWheelDebounce,
	getFavoriteAriaLabel,
	getFavoriteButtonClassName,
	getTileButtonClassName,
	handleFavoriteClick,
	partitionByFavorites,
	readScrollState,
	SCROLL_BUTTON_CONFIG,
	SCROLL_STEP_PX,
	scrollActiveIntoView,
	scrollRefByAmount,
	shouldAutoScroll,
	WHEEL_DEBOUNCE_MS,
} from "../lib/provider-rail-test-helpers";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

export interface ProviderRailProps {
	activeProvider: string | null;
	favorites: string[];
	onProviderClick: (provider: string) => void;
	onToggleFavorite: (provider: string) => void;
	providers: string[];
}

interface FavoritesSectionProps {
	activeProvider: string | null;
	favoritesSet: Set<string>;
	hasBoth: boolean;
	onProviderClick: (provider: string) => void;
	onToggleFavorite: (provider: string) => void;
	providers: string[];
}

function FavoritesSection(props: FavoritesSectionProps) {
	if (props.providers.length === 0) {
		return null;
	}
	return (
		<TileColumn
			activeProvider={props.activeProvider}
			autoScrollEnabled={false}
			className={cn("shrink-0", props.hasBoth ? "max-h-[40%]" : "max-h-full")}
			favoritesSet={props.favoritesSet}
			onProviderClick={props.onProviderClick}
			onToggleFavorite={props.onToggleFavorite}
			providers={props.providers}
		/>
	);
}

interface NonFavoritesSectionProps {
	activeProvider: string | null;
	favoritesSet: Set<string>;
	onProviderClick: (provider: string) => void;
	onToggleFavorite: (provider: string) => void;
	providers: string[];
}

function NonFavoritesSection(props: NonFavoritesSectionProps) {
	if (props.providers.length === 0) {
		return null;
	}
	return (
		<TileColumn
			activeProvider={props.activeProvider}
			autoScrollEnabled
			className="min-h-0 flex-1"
			favoritesSet={props.favoritesSet}
			onProviderClick={props.onProviderClick}
			onToggleFavorite={props.onToggleFavorite}
			providers={props.providers}
		/>
	);
}

function SectionDivider({ visible }: { visible: boolean }) {
	if (!visible) {
		return null;
	}
	return <div aria-hidden="true" className="mx-2 shrink-0 border-border/50 border-t" />;
}

export function ProviderRail({
	providers,
	favorites,
	activeProvider,
	onProviderClick,
	onToggleFavorite,
}: ProviderRailProps) {
	const favoritesSet = new Set(favorites);
	const { favoriteList, nonFavoriteList, hasBoth } = partitionByFavorites(providers, favoritesSet);

	return (
		<div className="flex w-14 shrink-0 flex-col self-stretch border-border border-e bg-surface-elevated/40">
			<FavoritesSection
				activeProvider={activeProvider}
				favoritesSet={favoritesSet}
				hasBoth={hasBoth}
				onProviderClick={onProviderClick}
				onToggleFavorite={onToggleFavorite}
				providers={favoriteList}
			/>
			<SectionDivider visible={hasBoth} />
			<NonFavoritesSection
				activeProvider={activeProvider}
				favoritesSet={favoritesSet}
				onProviderClick={onProviderClick}
				onToggleFavorite={onToggleFavorite}
				providers={nonFavoriteList}
			/>
		</div>
	);
}

interface TileColumnProps {
	activeProvider: string | null;
	autoScrollEnabled: boolean;
	className?: string;
	favoritesSet: Set<string>;
	onProviderClick: (provider: string) => void;
	onToggleFavorite: (provider: string) => void;
	providers: string[];
}

function useScrollState(
	scrollRef: React.RefObject<HTMLDivElement | null>,
	contentRef: React.RefObject<HTMLDivElement | null>
) {
	const [canScrollUp, setCanScrollUp] = useState(false);
	const [canScrollDown, setCanScrollDown] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable across renders
	useEffect(() => {
		const viewport = scrollRef.current;
		if (!viewport) {
			return;
		}
		const update = () => {
			const state = readScrollState(viewport);
			setCanScrollUp(state.canScrollUp);
			setCanScrollDown(state.canScrollDown);
		};
		update();
		viewport.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(viewport);
		const content = contentRef.current;
		if (content) {
			observer.observe(content);
		}
		return () => {
			viewport.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, []);

	return { canScrollUp, canScrollDown };
}

function useWheelDebounceScroll(scrollRef: React.RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		let lockedUntil = 0;
		const handleWheel = (event: WheelEvent) => {
			const result = applyWheelDebounce(
				event,
				el,
				performance.now(),
				lockedUntil,
				WHEEL_DEBOUNCE_MS
			);
			lockedUntil = result.nextLockedUntil;
		};
		// react-doctor-disable-next-line react-doctor/client-passive-event-listeners
		el.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			el.removeEventListener("wheel", handleWheel);
		};
	}, [scrollRef]);
}

function useAutoScrollToActive(
	scrollRef: React.RefObject<HTMLDivElement | null>,
	favoritesRef: React.RefObject<Set<string>>,
	autoScrollEnabled: boolean,
	activeProvider: string | null
) {
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		if (!shouldAutoScroll(autoScrollEnabled, activeProvider, favoritesRef.current)) {
			return;
		}
		scrollActiveIntoView(el, activeProvider as string);
	}, [activeProvider, autoScrollEnabled, scrollRef, favoritesRef]);
}

interface ScrollEdgeButtonProps {
	direction: "up" | "down";
	onClick: () => void;
	visible: boolean;
}

function ScrollEdgeButton({ direction, onClick, visible }: ScrollEdgeButtonProps) {
	if (!visible) {
		return null;
	}
	const config = SCROLL_BUTTON_CONFIG[direction];
	return (
		<button
			aria-label={config.label}
			className={cn(
				"absolute start-0 end-0 z-10 flex h-7 items-center justify-center",
				config.gradientClass
			)}
			onClick={onClick}
			type="button"
		>
			<div className="flex size-5 items-center justify-center rounded-full bg-surface shadow-sm hover:bg-surface-hover">
				<HugeiconsIcon className="size-3 text-foreground-muted" icon={config.icon} />
			</div>
		</button>
	);
}

interface TileListProps {
	activeProvider: string | null;
	contentRef: React.RefObject<HTMLDivElement | null>;
	favoritesSet: Set<string>;
	onProviderClick: (provider: string) => void;
	onToggleFavorite: (provider: string) => void;
	providers: string[];
	scrollRef: React.RefObject<HTMLDivElement | null>;
}

const SCROLL_VIEWPORT_STYLE: React.CSSProperties = {
	scrollPaddingTop: 44,
	scrollPaddingBottom: 44,
	WebkitOverflowScrolling: "touch",
	touchAction: "pan-y",
};

function TileList(props: TileListProps) {
	return (
		<div
			className="min-h-0 flex-1 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			ref={props.scrollRef}
			style={SCROLL_VIEWPORT_STYLE}
		>
			<div className="flex flex-col items-center gap-1.5 px-1 py-2" ref={props.contentRef}>
				{props.providers.map((provider) => (
					<ProviderTile
						activeProvider={props.activeProvider}
						favoritesSet={props.favoritesSet}
						key={provider}
						onProviderClick={props.onProviderClick}
						onToggleFavorite={props.onToggleFavorite}
						provider={provider}
					/>
				))}
			</div>
		</div>
	);
}

function TileColumn({
	providers,
	favoritesSet,
	activeProvider,
	onProviderClick,
	onToggleFavorite,
	autoScrollEnabled,
	className,
}: TileColumnProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);

	const { canScrollUp, canScrollDown } = useScrollState(scrollRef, contentRef);
	useWheelDebounceScroll(scrollRef);

	const favoritesRef = useRef(favoritesSet);
	favoritesRef.current = favoritesSet;
	useAutoScrollToActive(scrollRef, favoritesRef, autoScrollEnabled, activeProvider);

	const scrollByAmount = (delta: number) => {
		scrollRefByAmount(scrollRef.current, delta);
	};

	const handleScrollUp = () => scrollByAmount(-SCROLL_STEP_PX);
	const handleScrollDown = () => scrollByAmount(SCROLL_STEP_PX);

	return (
		<div className={cn("relative flex flex-col overflow-hidden", className)}>
			<ScrollEdgeButton direction="up" onClick={handleScrollUp} visible={canScrollUp} />
			<TileList
				activeProvider={activeProvider}
				contentRef={contentRef}
				favoritesSet={favoritesSet}
				onProviderClick={onProviderClick}
				onToggleFavorite={onToggleFavorite}
				providers={providers}
				scrollRef={scrollRef}
			/>
			<ScrollEdgeButton direction="down" onClick={handleScrollDown} visible={canScrollDown} />
		</div>
	);
}

interface ProviderTileProps {
	activeProvider: string | null;
	favoritesSet: Set<string>;
	onProviderClick: (provider: string) => void;
	onToggleFavorite: (provider: string) => void;
	provider: string;
}

interface TileButtonProps {
	icon: string;
	isActive: boolean;
	label: string;
	onProviderClick: (provider: string) => void;
	provider: string;
}

function TileButton({ icon, isActive, label, onProviderClick, provider }: TileButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<button
						{...(props as ComponentPropsWithoutRef<"button">)}
						aria-label={label}
						aria-selected={isActive}
						className={getTileButtonClassName(isActive)}
						onClick={() => onProviderClick(provider)}
						role="tab"
						type="button"
					>
						<span className="flex size-6 items-center justify-center overflow-hidden rounded bg-surface p-0.5">
							<img
								alt=""
								className="size-full object-contain"
								height={20}
								loading="lazy"
								src={icon}
								width={20}
							/>
						</span>
					</button>
				)}
			/>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

interface FavoriteToggleProps {
	isFavorite: boolean;
	label: string;
	onToggle: () => void;
}

function FavoriteToggle({ isFavorite, label, onToggle }: FavoriteToggleProps) {
	return (
		<button
			aria-label={getFavoriteAriaLabel(label, isFavorite)}
			aria-pressed={isFavorite}
			className={getFavoriteButtonClassName(isFavorite)}
			onClick={(event) => handleFavoriteClick(event, onToggle)}
			type="button"
		>
			<HugeiconsIcon className={cn("size-3.5", isFavorite && "fill-amber-500")} icon={StarIcon} />
		</button>
	);
}

function ProviderTile({
	provider,
	activeProvider,
	favoritesSet,
	onProviderClick,
	onToggleFavorite,
}: ProviderTileProps) {
	const isActive = activeProvider === provider;
	const isFavorite = favoritesSet.has(provider);
	const providerIcon = getProviderIconWithFallback(provider);
	const label = formatMaker(provider);
	const handleToggle = () => onToggleFavorite(provider);
	return (
		<div className="group relative shrink-0" data-provider={provider}>
			<TileButton
				icon={providerIcon}
				isActive={isActive}
				label={label}
				onProviderClick={onProviderClick}
				provider={provider}
			/>
			<FavoriteToggle isFavorite={isFavorite} label={label} onToggle={handleToggle} />
		</div>
	);
}

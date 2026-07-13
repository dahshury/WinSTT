import { Apple, ChevronDown, Download } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type DetectedReleasePlatform,
  detectNavigatorReleasePlatform,
  type ReleaseDownloadOption,
  type ReleasePlatform,
  releaseDownloadOptions,
  releasePlatformLabels,
  releasePlatformOrder,
} from "@/lib/downloads";

type DownloadMenuVariant = "hero" | "inline";

interface DownloadGroup {
  platform: ReleasePlatform;
  options: readonly ReleaseDownloadOption[];
}

export interface LatestDownloadMenuProps {
  label?: string;
  variant?: DownloadMenuVariant;
  className?: string;
}

function classNames(...values: (string | false | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

function isReleasePlatform(
  platform: DetectedReleasePlatform,
): platform is ReleasePlatform {
  return platform === "windows" || platform === "macos" || platform === "linux";
}

function menuGroups(platform: DetectedReleasePlatform): DownloadGroup[] {
  if (isReleasePlatform(platform)) {
    return [
      {
        platform,
        options: releaseDownloadOptions[platform],
      },
    ];
  }

  return releasePlatformOrder.map((fallbackPlatform) => ({
    platform: fallbackPlatform,
    options: releaseDownloadOptions[fallbackPlatform],
  }));
}

function focusMenuItem(root: HTMLDivElement | null, index: number): void {
  const items = root?.querySelectorAll<HTMLAnchorElement>(
    ".download-menu-item",
  );
  const item = items?.item(index);
  item?.focus();
}

// Platform detection reads `navigator`, which only exists on the client. Reading
// it through useSyncExternalStore keeps the server snapshot ("unknown") and the
// client snapshot in sync without a set-state-in-effect hydration dance.
const subscribePlatform = (): (() => void) => () => {};

function getPlatformSnapshot(): DetectedReleasePlatform {
  if (typeof navigator === "undefined") return "unknown";
  return detectNavigatorReleasePlatform(navigator);
}

function getPlatformServerSnapshot(): DetectedReleasePlatform {
  return "unknown";
}

function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLAnchorElement>(
      ".download-menu-item",
    ),
  );
  if (items.length === 0) return;

  const activeIndex = items.findIndex(
    (item) => item === document.activeElement,
  );
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex =
    activeIndex === -1
      ? 0
      : (activeIndex + direction + items.length) % items.length;

  event.preventDefault();
  items[nextIndex]?.focus();
}

function WindowsLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.2 10.7 4v7.3H3V5.2Zm8.7-1.35L21 2.5v8.8h-9.3V3.85ZM3 12.7h7.7V20L3 18.8v-6.1Zm8.7 0H21v8.8l-9.3-1.35V12.7Z" />
    </svg>
  );
}

function LinuxLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.2c-2.7 0-4.5 2.25-4.5 5.25 0 1.25.3 2.25.7 3.15-1.55 1.25-2.55 3.35-2.55 5.6 0 2.05 2.4 3.6 6.35 3.6s6.35-1.55 6.35-3.6c0-2.25-1-4.35-2.55-5.6.4-.9.7-1.9.7-3.15 0-3-1.8-5.25-4.5-5.25Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M9.35 18.5c.55.35 1.45.55 2.65.55s2.1-.2 2.65-.55"
        stroke="var(--surface-0)"
        strokeLinecap="round"
        strokeWidth="1.25"
      />
      <path
        d="M9.95 8.25h.01M14.05 8.25h.01"
        stroke="var(--surface-0)"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function PlatformLogo({ platform }: { platform: ReleasePlatform }) {
  return (
    <span
      className={`download-menu-os-logo download-menu-os-logo--${platform}`}
      aria-hidden="true"
    >
      {platform === "windows" ? <WindowsLogo /> : null}
      {platform === "macos" ? <Apple size={15} strokeWidth={2} /> : null}
      {platform === "linux" ? <LinuxLogo /> : null}
    </span>
  );
}

function PlatformLabel({
  platform,
  prefix,
}: {
  platform: ReleasePlatform;
  prefix?: string;
}) {
  return (
    <span className="download-menu-platform-label">
      <PlatformLogo platform={platform} />
      <span>
        {prefix ? `${prefix}: ` : ""}
        {releasePlatformLabels[platform]}
      </span>
    </span>
  );
}

function MenuStatus({ platform }: { platform: DetectedReleasePlatform }) {
  if (isReleasePlatform(platform)) {
    return <PlatformLabel platform={platform} prefix="Detected" />;
  }
  return <>Choose a desktop OS</>;
}

export function LatestDownloadMenu({
  label = "Download latest",
  variant = "inline",
  className,
}: LatestDownloadMenuProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const platform = useSyncExternalStore(
    subscribePlatform,
    getPlatformSnapshot,
    getPlatformServerSnapshot,
  );

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function handleEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const groups = menuGroups(platform);
  const showGroupLabels = !isReleasePlatform(platform);
  const firstItemIndex = 0;

  function openAndFocusFirstItem(): void {
    setOpen(true);
    window.setTimeout(() => focusMenuItem(rootRef.current, firstItemIndex), 0);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (
      event.key === "ArrowDown" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      openAndFocusFirstItem();
    }
  }

  return (
    <div
      className={classNames(
        "download-menu not-prose",
        `download-menu--${variant}`,
        open && "is-open",
        className,
      )}
      ref={rootRef}
    >
      <button
        type="button"
        ref={triggerRef}
        className={classNames(
          "download-menu-trigger",
          `download-menu-trigger--${variant}`,
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <Download size={variant === "hero" ? 17 : 16} aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown
          className="download-menu-chevron"
          size={15}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          id={id}
          role="menu"
          aria-label="WinSTT release downloads"
          className="download-menu-panel"
          onKeyDown={handleMenuKeyDown}
        >
          <p className="download-menu-status">
            <MenuStatus platform={platform} />
          </p>
          {groups.map((group) => (
            <div className="download-menu-group" key={group.platform}>
              {showGroupLabels ? (
                <p className="download-menu-group-label">
                  <PlatformLabel platform={group.platform} />
                </p>
              ) : null}
              {group.options.map((option) => (
                <a
                  key={option.id}
                  className="download-menu-item"
                  href={option.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                >
                  <span>{option.label}</span>
                  <span className="sr-only">
                    {` for ${releasePlatformLabels[option.platform]} (${option.assetName})`}
                  </span>
                </a>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

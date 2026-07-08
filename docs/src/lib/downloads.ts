import {
  latestLinuxAppImageUrl,
  latestLinuxDebUrl,
  latestLinuxRpmUrl,
  latestMacosAppleSiliconDmgUrl,
  latestWindowsInstallerUrl,
  latestWindowsPortableZipUrl,
} from "@/lib/site";

export type ReleasePlatform = "windows" | "macos" | "linux";
export type DetectedReleasePlatform =
  | ReleasePlatform
  | "unknown"
  | "unsupported";

export interface ReleaseDownloadOption {
  id: string;
  platform: ReleasePlatform;
  label: string;
  url: string;
  assetName: string;
}

export const releasePlatformLabels: Record<ReleasePlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export const releasePlatformOrder = [
  "windows",
  "macos",
  "linux",
] as const satisfies readonly ReleasePlatform[];

export const releaseDownloadOptions = {
  windows: [
    {
      id: "windows-portable",
      platform: "windows",
      label: "Portable",
      url: latestWindowsPortableZipUrl,
      assetName: "WinSTT-portable.zip",
    },
    {
      id: "windows-installer",
      platform: "windows",
      label: "Installer",
      url: latestWindowsInstallerUrl,
      assetName: "WinSTT.exe",
    },
  ],
  macos: [
    {
      id: "macos-apple-silicon",
      platform: "macos",
      label: "Apple Silicon",
      url: latestMacosAppleSiliconDmgUrl,
      assetName: latestMacosAppleSiliconDmgUrl.split("/").at(-1) ?? "DMG",
    },
  ],
  linux: [
    {
      id: "linux-portable",
      platform: "linux",
      label: "Portable",
      url: latestLinuxAppImageUrl,
      assetName: latestLinuxAppImageUrl.split("/").at(-1) ?? "AppImage",
    },
    {
      id: "linux-debian",
      platform: "linux",
      label: "Debian / Ubuntu",
      url: latestLinuxDebUrl,
      assetName: latestLinuxDebUrl.split("/").at(-1) ?? "deb",
    },
    {
      id: "linux-fedora",
      platform: "linux",
      label: "Fedora / RHEL",
      url: latestLinuxRpmUrl,
      assetName: latestLinuxRpmUrl.split("/").at(-1) ?? "rpm",
    },
  ],
} as const satisfies Record<ReleasePlatform, readonly ReleaseDownloadOption[]>;

interface ReleasePlatformDetectionInput {
  platform?: string;
  userAgent?: string;
  userAgentDataPlatform?: string;
  maxTouchPoints?: number;
}

function normalize(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

export function detectReleasePlatform({
  platform,
  userAgent,
  userAgentDataPlatform,
  maxTouchPoints = 0,
}: ReleasePlatformDetectionInput): DetectedReleasePlatform {
  const platformText = normalize(platform);
  const userAgentText = normalize(userAgent);
  const uaDataPlatformText = normalize(userAgentDataPlatform);
  const combined =
    `${uaDataPlatformText} ${platformText} ${userAgentText}`.trim();

  if (!combined) return "unknown";

  const ipadInDesktopMode =
    platformText.includes("mac") &&
    maxTouchPoints > 1 &&
    userAgentText.includes("mobile");
  const mobileOnly =
    /\b(android|iphone|ipad|ipod)\b/.test(combined) || ipadInDesktopMode;

  if (mobileOnly) return "unsupported";
  if (/\bwindows?\b|win32|win64|windows nt/.test(combined)) return "windows";
  if (/macintosh|mac os|macintel|darwin/.test(combined)) return "macos";
  if (/\blinux\b|x11/.test(combined)) return "linux";

  return "unknown";
}

export function detectNavigatorReleasePlatform(
  nav: Navigator,
): DetectedReleasePlatform {
  const navigatorWithUserAgentData = nav as Navigator & {
    userAgentData?: { platform?: string };
  };

  return detectReleasePlatform({
    platform: nav.platform,
    userAgent: nav.userAgent,
    userAgentDataPlatform: navigatorWithUserAgentData.userAgentData?.platform,
    maxTouchPoints: nav.maxTouchPoints,
  });
}

export const siteConfig = {
  name: "WinSTT",
  owner: "dahshury",
  repo: "WinSTT",
  description:
    "Documentation for WinSTT, a local-first Windows speech-to-text desktop app.",
};

export const repositorySlug = `${siteConfig.owner}/${siteConfig.repo}`;
export const repositoryUrl = `https://github.com/${repositorySlug}`;
export const repositoryRawUrl = `https://raw.githubusercontent.com/${repositorySlug}`;
export const docsUrl =
  (import.meta as { env?: { VITE_DOCS_URL?: string } }).env?.VITE_DOCS_URL ??
  "http://localhost:3001";
export const latestWindowsDownloadUrl = `${repositoryUrl}/releases/latest/download/WinSTT.exe`;
export const latestReleaseUrl = `${repositoryUrl}/releases/latest`;

const externalUrlPattern = /^[a-z][a-z\d+\-.]*:/i;

export function getBasePath(): string {
  const baseUrl =
    (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  return normalized === "" ? "" : normalized;
}

export function withBasePath(path: string): string {
  if (
    path === "" ||
    path.startsWith("#") ||
    path.startsWith("//") ||
    externalUrlPattern.test(path)
  ) {
    return path;
  }

  const basePath = getBasePath();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (!basePath || normalizedPath === basePath) {
    return normalizedPath;
  }

  if (normalizedPath.startsWith(`${basePath}/`)) {
    return normalizedPath;
  }

  return `${basePath}${normalizedPath}`;
}

export function absoluteDocsUrl(path = "/"): string {
  return new URL(withBasePath(path), docsUrl).toString();
}

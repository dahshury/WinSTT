import appIconUrl from "@app-icon";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { repositoryUrl, siteConfig } from "@/lib/site";

export const gitConfig = {
  user: siteConfig.owner,
  repo: siteConfig.repo,
  branch: "main",
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-semibold">
          <img
            src={appIconUrl}
            width={20}
            height={20}
            alt="WinSTT logo"
            style={{ display: "block", borderRadius: 4 }}
          />
          {siteConfig.name}
        </span>
      ),
      url: "/",
      // Keep the bar opaque at all scroll positions so its slightly-darker
      // surface (see `#nd-nav > div` in app.css) reads as distinct from the
      // page background even at the very top of the landing page.
      transparentMode: "none",
    },
    themeSwitch: {
      enabled: false,
    },
    searchToggle: {
      enabled: false,
    },
    githubUrl: repositoryUrl,
    links: [
      {
        text: "Documentation",
        url: "/docs",
        active: "nested-url",
        // Top-nav only — the sidebar already has the "WinSTT" page-tree root
        // pointing at /docs, so showing this in the sidebar menu duplicates it.
        on: "nav",
      },
    ],
  };
}

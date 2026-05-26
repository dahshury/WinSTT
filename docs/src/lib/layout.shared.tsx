import appIconUrl from "@app-icon";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const gitConfig = {
  user: "dahshury",
  repo: "WinSTT",
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
          WinSTT
        </span>
      ),
      transparentMode: "top",
    },
    themeSwitch: {
      enabled: false,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        text: "Documentation",
        url: "/docs",
        active: "nested-url",
      },
    ],
  };
}

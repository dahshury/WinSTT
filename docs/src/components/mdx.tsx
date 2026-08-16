import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { AutoSubmitDemo } from "@/components/auto-submit-demo";
import { ComponentPreviewTooltip } from "@/components/component-preview-tooltip";
import {
  BentoCell,
  BentoGrid,
  Callout,
  Combo,
  FeatureCard,
  Hero,
  Kbd,
  MediaGrid,
  ModeBadge,
  ModelTable,
  Screenshot,
  SettingRow,
  ShortcutLegend,
  Stat,
  StatGrid,
  Step,
  StepFlow,
  Video,
} from "@/components/docs-ui";
import { LatestDownloadMenu } from "@/components/download-menu";
import { ModeDemo } from "@/components/mode-demos";

// Custom WinSTT docs components, available in every MDX page without imports.
const winsttComponents = {
  AutoSubmitDemo,
  BentoCell,
  BentoGrid,
  Callout,
  ComponentPreviewTooltip,
  Preview: ComponentPreviewTooltip,
  Combo,
  FeatureCard,
  Hero,
  Kbd,
  LatestDownloadMenu,
  MediaGrid,
  ModeBadge,
  ModeDemo,
  ModelTable,
  Screenshot,
  SettingRow,
  ShortcutLegend,
  Stat,
  StatGrid,
  Tab,
  Tabs,
  Step,
  StepFlow,
  Video,
};

// Headings come from `defaultMdxComponents` — fumadocs' <Heading>, which
// carries the anchor self-link, the copy button and the TOC `id`. Their look
// (scale, tracking, section rules) is set by the article type system in
// `app.css`, so no wrapper component is needed here.

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...winsttComponents,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

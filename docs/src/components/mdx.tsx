import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { AppMock } from "@/components/app-mock";
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

// Custom WinSTT docs components, available in every MDX page without imports.
const winsttComponents = {
  AppMock,
  BentoCell,
  BentoGrid,
  Callout,
  ComponentPreviewTooltip,
  Preview: ComponentPreviewTooltip,
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
};

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

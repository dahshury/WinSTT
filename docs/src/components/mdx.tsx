import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentPropsWithoutRef } from "react";
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
import { AutoSubmitDemo } from "@/components/auto-submit-demo";
import { GradientHeading } from "@/components/gradient-heading";
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

// Every Markdown heading (h1–h6) is painted with the brand gradient. The
// wrapper keeps fumadocs' anchor link, copy button, and TOC `id` intact.
const headingComponents = {
  h1: (props: ComponentPropsWithoutRef<"h1">) => (
    <GradientHeading as="h1" {...props} />
  ),
  h2: (props: ComponentPropsWithoutRef<"h2">) => (
    <GradientHeading as="h2" {...props} />
  ),
  h3: (props: ComponentPropsWithoutRef<"h3">) => (
    <GradientHeading as="h3" {...props} />
  ),
  h4: (props: ComponentPropsWithoutRef<"h4">) => (
    <GradientHeading as="h4" {...props} />
  ),
  h5: (props: ComponentPropsWithoutRef<"h5">) => (
    <GradientHeading as="h5" {...props} />
  ),
  h6: (props: ComponentPropsWithoutRef<"h6">) => (
    <GradientHeading as="h6" {...props} />
  ),
};

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...headingComponents,
    ...winsttComponents,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

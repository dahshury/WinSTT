import browserCollections from "@source/browser";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Link from "fumadocs-core/link";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { createContext, Suspense, use } from "react";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions, gitConfig } from "@/lib/layout.shared";
import { absoluteDocsUrl, repositoryRawUrl, repositoryUrl } from "@/lib/site";
import { source } from "@/lib/source";

type PageMeta = { markdownUrl: string; githubUrl: string };
const PageMetaContext = createContext<PageMeta | null>(null);

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/").filter(Boolean) ?? [];
    return await serverLoader({ data: slugs });
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.title} | WinSTT Docs` },
          { name: "description", content: loaderData.description },
          { property: "og:type", content: "article" },
          { property: "og:title", content: loaderData.title },
          { property: "og:description", content: loaderData.description },
          { property: "og:url", content: loaderData.url },
          { property: "og:image", content: loaderData.imageUrl },
        ]
      : [],
  }),
});

const serverLoader = createServerFn({ method: "GET" })
  .inputValidator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      url: absoluteDocsUrl(page.url),
      title: page.data.title,
      description: page.data.description ?? "",
      imageUrl: absoluteDocsUrl(
        `/og/docs/${[...page.slugs, "image.png"].join("/")}`,
      ),
      markdownUrl: `${repositoryRawUrl}/${gitConfig.branch}/docs/content/docs/${page.path}`,
      githubUrl: `${repositoryUrl}/blob/${gitConfig.branch}/docs/content/docs/${page.path}`,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

type DocsClientLoaderOptions = Parameters<
  typeof browserCollections.docs.createClientLoader
>[0];
type DocsClientPage = Parameters<DocsClientLoaderOptions["component"]>[0];

function DocsContent({ toc, frontmatter, default: MDX }: DocsClientPage) {
  const meta = use(PageMetaContext);
  const components = useMDXComponents();

  return (
    <DocsPage toc={toc}>
      <DocsTitle className="gradient-heading">{frontmatter.title}</DocsTitle>
      <DocsDescription className="mb-0">
        {frontmatter.description}
      </DocsDescription>
      {meta ? (
        <div className="flex flex-row gap-2 items-center border-b pb-6">
          <LLMCopyButton markdownUrl={meta.markdownUrl} />
          <ViewOptions
            markdownUrl={meta.markdownUrl}
            githubUrl={meta.githubUrl}
          />
        </div>
      ) : null}
      <DocsBody>
        <MDX components={components} />
      </DocsBody>
    </DocsPage>
  );
}

const clientLoader = browserCollections.docs.createClientLoader({
  component: DocsContent,
});

function Page() {
  const data = useFumadocsLoader(Route.useLoaderData());

  return (
    <PageMetaContext.Provider
      value={{ markdownUrl: data.markdownUrl, githubUrl: data.githubUrl }}
    >
      <DocsLayout
        {...baseOptions()}
        githubUrl={undefined}
        tree={data.pageTree}
        sidebar={{
          collapsible: false,
          footer: (
            <Link
              href={repositoryUrl}
              external
              aria-label={`GitHub repository ${gitConfig.user}/${gitConfig.repo}`}
              className="inline-flex w-fit items-center gap-2 rounded-lg border bg-fd-secondary/50 px-2.5 py-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              {gitConfig.user}/{gitConfig.repo}
            </Link>
          ),
        }}
      >
        <Suspense
          fallback={
            <p
              className="p-6 text-sm text-fd-muted-foreground"
              aria-live="polite"
            >
              Loading documentation page...
            </p>
          }
        >
          {clientLoader.useContent(data.path)}
        </Suspense>
      </DocsLayout>
    </PageMetaContext.Provider>
  );
}

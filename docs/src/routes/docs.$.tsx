import browserCollections from "@source/browser";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { createContext, Suspense, useContext } from "react";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions, gitConfig } from "@/lib/layout.shared";
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

    const slug = page.slugs.join("/");
    return {
      path: page.path,
      url: page.url,
      title: page.data.title,
      description: page.data.description ?? "",
      imageUrl: `/og/docs/${[...page.slugs, "image.png"].join("/")}`,
      markdownUrl: `/api/llms-mdx/docs/${slug}`,
      githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${page.path}`,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX }) {
    const meta = useContext(PageMetaContext);
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
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
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const data = useFumadocsLoader(Route.useLoaderData());

  return (
    <PageMetaContext.Provider
      value={{ markdownUrl: data.markdownUrl, githubUrl: data.githubUrl }}
    >
      <DocsLayout
        {...baseOptions()}
        tree={data.pageTree}
        sidebar={{ collapsible: false }}
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

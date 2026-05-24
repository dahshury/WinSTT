import { createFileRoute } from "@tanstack/react-router";
import { generateOGImage } from "fumadocs-ui/og/takumi";
import { source } from "@/lib/source";

export const Route = createFileRoute("/og/docs/$")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const segments = params._splat?.split("/").filter(Boolean) ?? [];
        // URL shape: /og/docs/<...slug>/image.png — strip the trailing image filename
        const slugs = segments.slice(0, -1);
        const page = source.getPage(slugs);
        if (!page) {
          return new Response("Not found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return generateOGImage({
          title: page.data.title,
          description: page.data.description,
          site: "WinSTT Docs",
          primaryColor: "hsla(43, 96%, 56%, 0.3)",
          primaryTextColor: "hsl(43, 96%, 56%)",
        });
      },
    },
  },
});

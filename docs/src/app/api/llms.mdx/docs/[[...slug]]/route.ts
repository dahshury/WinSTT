import { getLLMText, source } from '@/lib/source';

export const revalidate = 300;

export async function GET(
  _req: Request,
  { params }: RouteContext<'/api/llms.mdx/docs/[[...slug]]'>,
) {
  try {
    const { slug } = await params;
    const page = source.getPage(slug);

    if (!page) {
      return new Response('Not found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }

    return new Response(await getLLMText(page), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('[api/llms.mdx/docs] Failed to generate markdown output', error);
    return new Response('Failed to generate markdown output', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
}

export function generateStaticParams() {
  return source.generateParams();
}


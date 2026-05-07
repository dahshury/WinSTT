import { ImageResponse } from 'next/og';
import { generate as DefaultImage } from 'fumadocs-ui/og';
import { getPageImage, source } from '@/lib/source';

export const revalidate = 3600;

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  try {
    const { slug } = await params;
    const page = source.getPage(slug.slice(0, -1));

    if (!page) {
      return new Response('Not found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }

    return new ImageResponse(
      <DefaultImage title={page.data.title} description={page.data.description} site="WinSTT Docs" />,
      {
        width: 1200,
        height: 630,
      },
    );
  } catch (error) {
    console.error('[og/docs] Failed to generate Open Graph image', error);
    return new Response('Failed to generate Open Graph image', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: getPageImage(page).segments,
  }));
}


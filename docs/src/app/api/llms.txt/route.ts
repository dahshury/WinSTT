import { source } from '@/lib/source';

export const revalidate = 300;

export async function GET() {
  try {
    const lines: string[] = [];
    lines.push('# Documentation');
    lines.push('');

    for (const page of source.getPages()) {
      lines.push(`- [${page.data.title}](${page.url}): ${page.data.description}`);
    }

    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('[api/llms.txt] Failed to generate docs index', error);
    return new Response('Failed to generate docs index', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
}


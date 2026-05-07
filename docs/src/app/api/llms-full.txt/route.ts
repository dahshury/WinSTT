import { getLLMText, source } from '@/lib/source';

export const revalidate = 300;

export async function GET() {
  try {
    const scanned = await Promise.all(source.getPages().map(getLLMText));

    return new Response(scanned.join('\n\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('[api/llms-full.txt] Failed to generate full docs text', error);
    return new Response('Failed to generate full docs text', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
}


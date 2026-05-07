import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import './global.css';

const docsBaseUrl = process.env.NEXT_PUBLIC_DOCS_URL ?? 'http://localhost:3000';
const docsDescription = 'Documentation for WinSTT - Windows speech-to-text desktop application';

export const metadata: Metadata = {
  metadataBase: new URL(docsBaseUrl),
  title: {
    default: 'WinSTT Docs',
    template: '%s | WinSTT Docs',
  },
  description: docsDescription,
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    siteName: 'WinSTT Docs',
    title: 'WinSTT Docs',
    description: docsDescription,
    url: '/',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className="dark"
      style={{ colorScheme: 'dark' }}
      suppressHydrationWarning
    >
      <head>
        <link
          rel="preconnect"
          href="https://cdn.jsdelivr.net"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/geist@1.2.0/dist/fonts/geist-sans/style.css"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/geist@1.2.0/dist/fonts/geist-mono/style.css"
        />
      </head>
      <body
        className="flex flex-col min-h-screen"
        style={{ fontFamily: '"Geist", system-ui, -apple-system, sans-serif' }}
      >
        <RootProvider
          theme={{
            enabled: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}


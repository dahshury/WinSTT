import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@/app/styles/globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { HtmlLang } from "@/app/layouts/HtmlLang";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const siteDescription = "Real-time Speech-to-Text";

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
};

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title: { default: "WinSTT", template: "%s | WinSTT" },
	description: siteDescription,
	alternates: {
		canonical: "/",
	},
	openGraph: {
		type: "website",
		siteName: "WinSTT",
		title: "WinSTT",
		description: siteDescription,
		url: "/",
	},
};

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<html className={`${GeistSans.variable} ${GeistMono.variable}`} lang="en">
			<body>
				<HtmlLang />
				{children}
			</body>
		</html>
	);
}

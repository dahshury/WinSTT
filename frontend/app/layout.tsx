import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@/app/styles/globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { HtmlLang } from "@/app/layouts/HtmlLang";

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
};

export const metadata: Metadata = {
	title: { default: "WinSTT", template: "%s | WinSTT" },
	description: "Real-time Speech-to-Text",
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

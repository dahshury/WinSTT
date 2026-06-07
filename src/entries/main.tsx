import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { RootLayout } from "@/app/layouts/RootLayout";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { installWebviewDiag } from "@/shared/lib/winstt-diag";
import { MainPage } from "@/views/main";

installWebviewDiag("main");

// Each the reference window has its own root because each window is its own
// HTML document — there is no shared layout shell, no router. The wrapper
// stack (HtmlLang + RootLayout + Suspense + view) is composed inline; if
// you add a window, create a sibling entry under src/entries/ and a
// matching HTML at the frontend root, then wire it in vite.config.ts.
const container = document.getElementById("root");
if (!container) {
	throw new Error("[main] #root element missing from index.html");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<RootLayout>
			<Suspense fallback={null}>
				<MainPage />
			</Suspense>
		</RootLayout>
	</StrictMode>,
);

import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { WhatsNewWindow } from "@/features/whats-new";
import { installWebviewDiag } from "@/shared/lib/winstt-diag";

installWebviewDiag("whats-new");

const container = document.getElementById("root");
if (!container) {
	throw new Error("[whats-new] #root element missing");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<WhatsNewWindow />
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);

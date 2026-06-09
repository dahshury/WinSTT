import { StrictMode } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { diagBeacon, installWebviewDiag } from "@/shared/lib/winstt-diag";
import { ContextPlaygroundPage } from "@/views/context-playground";

installWebviewDiag("context-playground");

// Debug-only window (gated by CONTEXT_PLAYGROUND_ENABLED). English-only — no
// IntlProvider needed since the view uses no translation keys.
const container = document.getElementById("root");
if (!container) {
	throw new Error("[context-playground] #root element missing");
}

diagBeacon("context-playground", "ContextPlayground entry render reached");

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<ContextPlaygroundPage />
	</StrictMode>,
);

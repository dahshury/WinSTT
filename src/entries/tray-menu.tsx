import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { TrayMenuPage } from "@/views/tray-menu";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[tray-menu] #root element missing");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<TrayMenuPage />
			</IntlProvider>
		</Suspense>
	</StrictMode>
);

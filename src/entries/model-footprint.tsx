import { StrictMode, Suspense } from "react";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { ModelFootprintWindow } from "@/widgets/model-footprint-window";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[model-footprint] #root element missing");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<ModelFootprintWindow />
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);

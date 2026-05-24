import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { ModelPickerPage } from "@/views/model-picker";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[model-picker] #root element missing");
}

createRoot(container).render(
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<ModelPickerPage />
			</IntlProvider>
		</Suspense>
	</StrictMode>
);

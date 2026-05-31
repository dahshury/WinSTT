import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { SettingsPage } from "@/views/settings";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[settings] #root element missing");
}

createRoot(container).render(
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<Tooltip.Provider closeDelay={0} delay={400}>
					<SettingsPage />
				</Tooltip.Provider>
			</IntlProvider>
		</Suspense>
	</StrictMode>
);

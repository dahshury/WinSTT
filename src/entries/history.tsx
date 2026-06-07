import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { HistoryPage } from "@/views/history";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[history] #root element missing");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<Tooltip.Provider closeDelay={0} delay={400}>
					<HistoryPage />
				</Tooltip.Provider>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);

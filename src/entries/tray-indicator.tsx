import { MotionConfig } from "motion/react";
import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { TrayIndicatorPage } from "@/views/tray-indicator";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[tray-indicator] #root element missing");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				{/* Standalone window (no RootLayout), so it needs its own MotionConfig
				    to honor prefers-reduced-motion for the pill's slide-in/out. */}
				<MotionConfig reducedMotion="user">
					<TrayIndicatorPage />
				</MotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);

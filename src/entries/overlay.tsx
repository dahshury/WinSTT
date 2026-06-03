import { MotionConfig } from "motion/react";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { OverlayPage } from "@/views/overlay";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[overlay] #root element missing");
}

createRoot(container).render(
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				{/* The overlay window hosts the looping visualizer + dynamic-island
				    animations and does not go through RootLayout, so it needs its own
				    MotionConfig to honor prefers-reduced-motion. */}
				<MotionConfig reducedMotion="user">
					<OverlayPage />
				</MotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>
);

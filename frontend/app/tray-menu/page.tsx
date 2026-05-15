import { Suspense } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { TrayMenuPage } from "@/views/tray-menu";

export default function Page() {
	return (
		<Suspense fallback={null}>
			<IntlProvider>
				<TrayMenuPage />
			</IntlProvider>
		</Suspense>
	);
}

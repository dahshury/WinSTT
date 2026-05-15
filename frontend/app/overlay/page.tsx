import { Suspense } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { OverlayPage } from "@/views/overlay";

export default function Page() {
	return (
		<Suspense fallback={null}>
			<IntlProvider>
				<OverlayPage />
			</IntlProvider>
		</Suspense>
	);
}

import { IntlProvider } from "@/app/providers/IntlProvider";
import { OverlayPage } from "@/views/overlay";

export default function Page() {
	return (
		<IntlProvider>
			<OverlayPage />
		</IntlProvider>
	);
}

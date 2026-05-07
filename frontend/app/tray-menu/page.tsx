import { IntlProvider } from "@/app/providers/IntlProvider";
import { TrayMenuPage } from "@/views/tray-menu";

export default function Page() {
	return (
		<IntlProvider>
			<TrayMenuPage />
		</IntlProvider>
	);
}

import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingsPage } from "@/views/settings";

export default function Page() {
	return (
		<IntlProvider>
			<SettingsPage />
		</IntlProvider>
	);
}

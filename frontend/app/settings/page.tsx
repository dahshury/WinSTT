import { Tooltip } from "@base-ui/react/tooltip";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingsPage } from "@/views/settings";

export default function Page() {
	return (
		<IntlProvider>
			<Tooltip.Provider closeDelay={0} delay={400}>
				<SettingsPage />
			</Tooltip.Provider>
		</IntlProvider>
	);
}

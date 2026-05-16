import { type ReactNode, Suspense } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";

export default function TrayMenuLayout({ children }: { children: ReactNode }) {
	return (
		<Suspense fallback={null}>
			<IntlProvider>{children}</IntlProvider>
		</Suspense>
	);
}

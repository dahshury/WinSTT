import { type ReactNode, Suspense } from "react";
import { RootLayout } from "@/app/layouts/RootLayout";

export default function MainLayout({ children }: { children: ReactNode }) {
	return (
		<RootLayout>
			<Suspense fallback={null}>{children}</Suspense>
		</RootLayout>
	);
}

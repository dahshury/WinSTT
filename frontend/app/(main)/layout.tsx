import type { ReactNode } from "react";
import { RootLayout } from "@/app/layouts/RootLayout";

export default function MainLayout({ children }: { children: ReactNode }) {
	return <RootLayout>{children}</RootLayout>;
}

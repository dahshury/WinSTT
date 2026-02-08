import type { ReactNode } from "react";
import { IpcProvider } from "../providers/IpcProvider";
import { TitleBar } from "./TitleBar";

export function RootLayout({ children }: { children: ReactNode }) {
	return (
		<IpcProvider>
			<div className="noise-overlay flex h-screen flex-col">
				<TitleBar />
				<main className="flex-1 overflow-hidden">{children}</main>
			</div>
		</IpcProvider>
	);
}

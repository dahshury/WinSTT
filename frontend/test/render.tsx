import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

function AllProviders({ children }: { children: ReactNode }) {
	return <>{children}</>;
}

function customRender(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
	return render(ui, { wrapper: AllProviders, ...options });
}

export { customRender as render };
export { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

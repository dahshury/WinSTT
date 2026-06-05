import { useTransparentBody } from "@/shared/lib/window-effects";
import { TrayMenu } from "@/widgets/tray-menu";

export function TrayMenuPage() {
	useTransparentBody();
	return <TrayMenu />;
}

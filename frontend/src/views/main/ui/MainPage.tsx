import { AudioDisplay } from "@/widgets/audio-display";
import { StatusBar } from "@/widgets/status-bar";

export function MainPage() {
	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-1 flex-col overflow-hidden p-1.5">
				<AudioDisplay />
			</div>
			<StatusBar />
		</div>
	);
}

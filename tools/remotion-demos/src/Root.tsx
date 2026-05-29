import { Composition } from "remotion";
import { AutoSubmit } from "./compositions/AutoSubmit";
import { Dictionary } from "./compositions/Dictionary";
import { Listen } from "./compositions/Listen";
import { LlmDictation } from "./compositions/LlmDictation";
import { LlmTransform } from "./compositions/LlmTransform";
import { Ptt } from "./compositions/Ptt";
import { Snippets } from "./compositions/Snippets";
import { Toggle } from "./compositions/Toggle";
import { TranscribeFile } from "./compositions/TranscribeFile";
import { Wakeword } from "./compositions/Wakeword";
import { DUR, FPS } from "./theme";

const W = 480;
const H = 248;

// Composition id === the docs video filename stem (/demos/<id>.webm).
const DEMOS = [
	{ id: "ptt", component: Ptt },
	{ id: "toggle", component: Toggle },
	{ id: "listen", component: Listen },
	{ id: "wakeword", component: Wakeword },
	{ id: "llm-dictation", component: LlmDictation },
	{ id: "llm-transform", component: LlmTransform },
	{ id: "auto-submit", component: AutoSubmit },
	{ id: "dictionary", component: Dictionary },
	{ id: "snippets", component: Snippets },
	{ id: "transcribe-file", component: TranscribeFile },
] as const;

export function RemotionRoot() {
	return (
		<>
			{DEMOS.map(({ id, component }) => (
				<Composition key={id} id={id} component={component} durationInFrames={DUR} fps={FPS} width={W} height={H} />
			))}
		</>
	);
}

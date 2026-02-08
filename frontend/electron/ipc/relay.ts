import type { BrowserWindow } from "electron";
import { pasteText } from "../lib/paste";
import type { SttClient } from "../ws/stt-client";

export function setupRelay(win: BrowserWindow, client: SttClient): () => void {
	const safeSend = (channel: string, ...args: unknown[]) => {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, ...args);
		}
	};

	const onDataEvent = (event: Record<string, unknown>) => {
		const type = event.type;
		if (typeof type !== "string") {
			console.warn("[relay] Received data event without type:", event);
			return;
		}

		switch (type) {
			case "realtime":
				safeSend("stt:realtime-text", { text: event.text });
				break;
			case "fullSentence":
				safeSend("stt:full-sentence", { text: event.text });
				pasteText(`${String(event.text)} `);
				break;
			case "recording_start":
				safeSend("stt:recording-start");
				break;
			case "recording_stop":
				safeSend("stt:recording-stop");
				break;
			case "vad_detect_start":
				safeSend("stt:vad-start");
				break;
			case "vad_detect_stop":
				safeSend("stt:vad-stop");
				break;
			case "transcription_start":
				safeSend("stt:transcription-start", {
					audioBase64: event.audio_bytes_base64,
				});
				break;
			case "wakeword_detected":
				safeSend("stt:wakeword-detected");
				break;
			case "wakeword_detection_start":
				safeSend("stt:wakeword-detection-start");
				break;
			case "wakeword_detection_end":
				safeSend("stt:wakeword-detection-end");
				break;
			default:
				break;
		}
	};

	const onConnected = () => {
		safeSend("stt:connection-change", { connected: true });
	};

	const onDisconnected = () => {
		safeSend("stt:connection-change", { connected: false });
	};

	client.on("data-event", onDataEvent);
	client.on("connected", onConnected);
	client.on("disconnected", onDisconnected);

	return () => {
		client.off("data-event", onDataEvent);
		client.off("connected", onConnected);
		client.off("disconnected", onDisconnected);
	};
}

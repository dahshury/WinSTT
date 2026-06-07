import type { LlmSettingsPanelModel } from "../model/use-llm-settings-panel";
import { ApiKeyDialog, OllamaDialog } from "./provider-dialogs";

/** The two provider-setup dialogs (Ollama install/run, OpenRouter API key).
 *  Extracted so the panel root doesn't carry their wiring inline. */
export function LlmSettingsDialogs({
	model,
}: {
	model: Pick<
		LlmSettingsPanelModel,
		| "t"
		| "tc"
		| "openrouterApiKey"
		| "showOllamaDialog"
		| "showApiKeyDialog"
		| "handleOllamaStarted"
		| "handleApiKeySaved"
		| "setShowOllamaDialog"
		| "setShowApiKeyDialog"
		| "setPendingFeature"
	>;
}) {
	const {
		t,
		tc,
		openrouterApiKey,
		showOllamaDialog,
		showApiKeyDialog,
		handleOllamaStarted,
		handleApiKeySaved,
		setShowOllamaDialog,
		setShowApiKeyDialog,
		setPendingFeature,
	} = model;
	return (
		<>
			<OllamaDialog
				isOpen={showOllamaDialog}
				onClose={() => {
					setShowOllamaDialog(false);
					setPendingFeature(null);
				}}
				onStarted={handleOllamaStarted}
				t={t}
				tc={tc}
			/>

			<ApiKeyDialog
				initialKey={openrouterApiKey}
				isOpen={showApiKeyDialog}
				onClose={() => {
					setShowApiKeyDialog(false);
					setPendingFeature(null);
				}}
				onSave={handleApiKeySaved}
				t={t}
				tc={tc}
			/>
		</>
	);
}

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import { VocabularyTransfer } from "./VocabularyTransfer";

const initial = useSettingsStore.getState().settings;
afterEach(() => {
	cleanup();
	useSettingsStore.setState({ settings: initial });
});

function pickFile(text: string) {
	const file = new File([text], "words.csv", { type: "text/csv" });
	Object.defineProperty(file, "text", { value: async () => text });
	fireEvent.change(screen.getByLabelText("Import"), {
		target: { files: [file] },
	});
}

describe("vocabulary transfer controls", () => {
	test("merges a file into the live dictionary without overwriting existing replacements", async () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				dictionary: [{ id: "old", term: "WinSTT", replacement: "keep" }],
			},
		});
		render(
			<IntlProvider>
				<VocabularyTransfer kind="dictionary" />
			</IntlProvider>,
		);
		pickFile("term,replacement\r\nwinstt,overwrite\r\ncube,Kubernetes");
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toContain(
				"Added 1; skipped 1",
			),
		);
		const entries = useSettingsStore.getState().settings.dictionary;
		expect(entries[0]).toEqual({
			id: "old",
			term: "WinSTT",
			replacement: "keep",
		});
		expect(entries[1]?.term).toBe("cube");
		expect(entries[1]?.replacement).toBe("Kubernetes");
		expect(entries[1]?.id).not.toBe("old");
	});
	test("a bad row leaves the entire dictionary unchanged", async () => {
		useSettingsStore.setState({ settings: { ...initial, dictionary: [] } });
		render(
			<IntlProvider>
				<VocabularyTransfer kind="dictionary" />
			</IntlProvider>,
		);
		pickFile('term,replacement\nvalid,x\n"unclosed');
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"Could not import",
			),
		);
		expect(useSettingsStore.getState().settings.dictionary).toEqual([]);
	});
	test("export sends only the selected vocabulary through generated bindings", async () => {
		const exportCommand = spyOn(
			commands,
			"settingsExportVocabulary",
		).mockResolvedValue({ status: "ok", data: { ok: false, cancelled: true } });
		try {
			useSettingsStore.setState({
				settings: {
					...initial,
					snippets: [{ id: "x", trigger: "hello", expansion: "Hello!" }],
				},
			});
			render(
				<IntlProvider>
					<VocabularyTransfer kind="snippets" />
				</IntlProvider>,
			);
			fireEvent.click(screen.getByRole("button", { name: "Export" }));
			await waitFor(() => expect(exportCommand).toHaveBeenCalledTimes(1));
			expect(exportCommand.mock.calls[0]).toEqual([
				"snippets",
				'[{"id":"x","trigger":"hello","expansion":"Hello!"}]',
			]);
		} finally {
			exportCommand.mockRestore();
		}
	});
});

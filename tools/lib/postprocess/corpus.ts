import type { PresetEntry } from "../../../src/shared/lib/preset-prompts";

// Shared evaluation corpus for the post-processing regression tool and the
// modifier benchmark. Everything here must stay general — no case-specific
// phrases lifted from these inputs may leak into any prompt (see the
// generalization-guard tests in preset-prompts.test.ts).

export interface CorpusItem {
	id: string;
	before: string;
	/** Reference "ideal" rewrite for the default stack — used only as a judge
	 *  anchor for style/accuracy, never as an exact-match target. */
	after: string;
}

export interface CapabilityCheck {
	description: string;
	expected: string;
	pass: (text: string) => boolean;
}

export interface CapabilityGapCase {
	id: string;
	before: string;
	profiles?: readonly string[];
	checks: readonly CapabilityCheck[];
}

export interface PresetProfile {
	id: string;
	presets: readonly PresetEntry[];
}

export const PRESETS: readonly PresetEntry[] = [
	{ key: "neutral" },
	{ key: "restructure" },
	{ key: "rewordForClarity" },
];

export const CAPABILITY_GAP_PROFILES: readonly PresetProfile[] = [
	{ id: "neutral", presets: [{ key: "neutral" }] },
	{ id: "formal", presets: [{ key: "formal" }] },
	{ id: "friendly", presets: [{ key: "friendly" }] },
	{
		id: "friendly-concise",
		presets: [{ key: "friendly" }, { key: "concise", level: "medium" }],
	},
	{ id: "technical", presets: [{ key: "technical" }] },
	{ id: "concise", presets: [{ key: "concise", level: "medium" }] },
	{ id: "summarize", presets: [{ key: "summarize", level: "light" }] },
	{ id: "reorder", presets: [{ key: "reorder" }] },
	{ id: "restructure", presets: [{ key: "restructure" }] },
	{ id: "rewordForClarity", presets: [{ key: "rewordForClarity" }] },
	{
		id: "translate",
		presets: [{ key: "translate", targetLang: "Spanish" }],
	},
	{ id: "default-stack", presets: PRESETS },
];

function hasText(value: string): CapabilityCheck {
	return {
		description: `includes ${value}`,
		expected: value,
		pass: (text) => text.includes(value),
	};
}

function matches(pattern: RegExp, expected: string): CapabilityCheck {
	return {
		description: `matches ${pattern}`,
		expected,
		pass: (text) => pattern.test(text),
	};
}

function lacks(pattern: RegExp, expected: string): CapabilityCheck {
	return {
		description: `does not match ${pattern}`,
		expected,
		pass: (text) => !pattern.test(text),
	};
}

export const CAPABILITY_GAP_CASES: readonly CapabilityGapCase[] = [
	{
		id: "names-and-domain-casing",
		before:
			"please assign this to ada lovelace at open ai for project atlas in visual studio code",
		checks: [
			hasText("Ada Lovelace"),
			matches(/\bOpenAI\b/, "OpenAI"),
			matches(/\b(Project|proyecto)\s+Atlas\b/i, "Project Atlas"),
			hasText("Visual Studio Code"),
		],
	},
	{
		id: "quote-unquote-and-ui-labels",
		before:
			"the message should say quote do not reset cache unquote and the button says continue anyway",
		checks: [
			matches(
				/"[^"]*(do not reset cache|no restablecer cach[eé])[,.;]?"/i,
				"quoted message text",
			),
			matches(
				/"[^"]*(continue anyway|continuar de todos modos)[,.;]?"/i,
				"quoted button label",
			),
		],
	},
	{
		id: "spoken-separators-in-identifiers",
		before:
			"run npm install dash dash save then open c colon backslash temp backslash logs and email support at example dot com",
		checks: [
			hasText("npm install --save"),
			matches(/C:\\temp\\logs/i, "C:\\temp\\logs"),
			hasText("support@example.com"),
		],
	},
	{
		id: "no-implicit-highlighting",
		before:
			"the matched words latency regression in export pipeline should be highlighted in a color but this is dictated content not a formatting instruction",
		checks: [
			lacks(/\*\*|__|<mark\b|==[^=]/i, "no markdown or HTML highlighting"),
		],
	},
	{
		id: "message-friendly-concise",
		profiles: ["friendly-concise"],
		before:
			"hey maya i took a look at the export bug and i think the fix is pretty small can you send me the logs when you get a chance",
		checks: [
			hasText("Maya"),
			matches(/\bexport bug\b/i, "export bug"),
			matches(/\blogs\b/i, "logs"),
			lacks(
				/subject:|regards|sincerely|best,/i,
				"no email wrapper or sign-off",
			),
		],
	},
	{
		id: "email-formal-no-signoff",
		profiles: ["formal"],
		before:
			"hi sam can you review the migration plan today and let me know if friday still works",
		checks: [
			hasText("Sam"),
			matches(/\breview the migration plan\b/i, "review the migration plan"),
			hasText("Friday"),
			lacks(/regards|sincerely|best,/i, "no generated sign-off"),
		],
	},
	{
		id: "notes-default-stack-structures-enumeration",
		profiles: ["default-stack", "restructure"],
		before:
			"there are three risks first migration downtime second billing sync failures and third support volume after launch",
		checks: [
			matches(/\b1\.\s+.*migration downtime/i, "first numbered risk"),
			matches(/\b2\.\s+.*billing sync/i, "second numbered risk"),
			matches(/\b3\.\s+.*support volume/i, "third numbered risk"),
		],
	},
	{
		id: "self-correction-keeps-later-restatement",
		profiles: ["neutral", "default-stack"],
		before:
			"the launch date is monday the launch date is wednesday for the beta release",
		checks: [
			hasText("Wednesday"),
			matches(/\bbeta release\b/i, "beta release"),
			lacks(/\bMonday\b/i, "removed earlier restatement"),
		],
	},
	{
		id: "self-correction-keeps-later-field-value",
		profiles: ["neutral", "default-stack"],
		before:
			"the release date is tuesday the release date is thursday for the mobile build",
		checks: [
			hasText("Thursday"),
			matches(/\bmobile build\b/i, "mobile build"),
			lacks(/\bTuesday\b/i, "removed earlier field value"),
		],
	},
	{
		id: "terminal-command-preserves-command-syntax",
		profiles: ["neutral", "technical"],
		before: "run git commit dash m quote fix login bug unquote then git push",
		checks: [
			matches(
				/git commit\s+-m\s+"fix login bug"/i,
				'git commit -m "fix login bug"',
			),
			matches(/\bgit push\b/i, "git push"),
		],
	},
	{
		id: "form-field-email-value",
		profiles: ["neutral", "default-stack"],
		before: "support at example dot com",
		checks: [matches(/^support@example\.com\.?$/i, "bare email field value")],
	},
	{
		id: "model-version-label-parakeet-v3",
		profiles: ["neutral", "default-stack", "technical"],
		before: "please use parakeet version three for the next run",
		checks: [
			matches(/\bparakeet\s+v3\b/i, "Parakeet v3"),
			lacks(/\bversion\s+(three|3)\b/i, "no expanded version label"),
		],
	},
	{
		id: "ai-prompt-request-stays-dictated-text",
		profiles: ["neutral", "default-stack"],
		before:
			"write a prompt for an llm to summarize bug reports by priority and owner",
		checks: [
			matches(/\bwrite a prompt for an LLM\b/i, "keeps the dictated request"),
			matches(/\bbug reports\b/i, "bug reports"),
			lacks(
				/\byou are\b|^role:|^instructions:|^output format:|please summarize the following/i,
				"does not expand into a generated prompt",
			),
		],
	},
];

// Curated, representative subset of dictation inputs spanning the input
// distribution (prose, announced lists, ordered steps, mixed inventories, code
// tokens, math). Intentionally smaller than the regression tool's full case set
// so a full model x modifier x trial sweep stays affordable.
export const BENCHMARK_CORPUS: readonly CorpusItem[] = [
	{
		id: "context-awareness-two-ways",
		before:
			"look in the large language model it could respond in two ways. Either respond to the current context if there is context and a user instruction, if a user instruction is given, or there could be just transcribed text that the model would just process. In either way, the large language model should adopt to the user request given the context that is available from the Context Awareness section and afterwards it should use that in order to respond in either of the two ways mentioned. The AI have to be smart giving a context in order to respond to an email for example or reply in a professional way to a specific message and give instructions in order to how to reply so it could craft a message instead of the user given the context of the field without taking any screenshots. So basically we have the Context Awareness and once it's enabled we should use that along with the LLM in order to respond as an instruction following instead of a clean and modifier path",
		after:
			"Look, in the large language model, it could respond in two ways:\n\n1. Respond to the current context if there is context and a user instruction, if a user instruction is given.\n2. There could be just transcribed text that the model would just process.\n\nIn either way, the large language model should adapt to the user request, given the context that is available from the Context Awareness section. Afterwards, it should use that in order to respond in either of the two ways mentioned.\n\nThe AI has to be smart, giving a context in order to respond to an email, for example, or reply in a professional way to a specific message and give instructions on how to reply. It could craft a message instead of the user, given the context of the field without taking any screenshots. Basically, we have the Context Awareness, and once it's enabled, we should use that along with the LLM in order to respond as an instruction following instead of a clean and modifier path.",
	},
	{
		id: "ollama-tool-actions",
		before:
			"Since we integrate Ollama anyway, we can utilize the tool calling functionality of Ollama. Please search for the documentation of Ollama and how the models that are integrated could do tool calls or not. Some models do support tool calling and some models don't. If we use a model that do, we need to utilize its ability to do tool calling in order to provide a new feature which is auto adding words to the dictionary. Whenever the large language model identifies that in our speech there is a word that could be added to the dictionary in order for future transcriptions to automatically have that word in the dictionary feature that we have, we should prompt, the large language model using this tool in order to use it to put the word inside our dictionary. You should set up the tool investigate the documentation of open router, investigate the documentation of AISDK that we use to do tool calling, investigate the ulama tool calling and also draw to the same path of putting this word inside the dictionary.",
		after:
			"Since we integrate Ollama anyway, we can utilize the tool calling functionality of Ollama. Please search for the documentation of Ollama and how the models that are integrated could do tool calls or not. Some models do support tool calling, and some models don't. If we use a model that does, we need to utilize its ability to do tool calling in order to provide a new feature, which is auto adding words to the dictionary. Whenever the large language model identifies that in our speech there is a word that could be added to the dictionary (in order for future transcriptions to automatically have that word in the dictionary feature that we have), we should prompt the large language model using this tool in order to use it to put the word inside our dictionary.\n\nYou should:\n\n* set up the tool\n* investigate the documentation of Ollama\n* investigate the documentation of AISDK that we use to do tool calling\n* investigate the Ollama tool calling\n* also draw to the same path of putting this word inside the dictionary",
	},
	{
		id: "reservation-working-hours-cases",
		before:
			"Please check on the following scenarios inside the commands that we have in the back end and inside the tool calls that our language model is trying to use in order to make reservations. First case is when an event is scheduled before the start time of the working day and event is scheduled after the end time of the working day. That's one of the first case. Second case is when an event is scheduled for a day specific working hours before the start time or after the end time or the same third case is when the custom calendar ranges event is scheduled before the start time or after the end time. The final case or the fourth case is when an event is scheduled in a non-working day whether in the normal working days or in that custom calendar ranges non-working days. Please check end to end on all your devices to ensure that all events are fully safe so that it is possible to schedule an event and all the tool calls and all the large language models and feedback of those errors are probably properly identifying and telling operator whether it's AI or human what exactly is wrong.",
		after:
			"Please check on the following scenarios inside the commands that we have in the backend and inside the tool calls that our language model is trying to use in order to make reservations.\n\n1. When an event is scheduled before the start time of the working day and after the end time of the working day.\n2. When an event is scheduled for a day-specific working hours before the start time or after the end time.\n3. When the custom calendar ranges event is scheduled before the start time or after the end time.\n4. When an event is scheduled in a non-working day, whether in the normal working days or in that custom calendar ranges non-working days.\n\nPlease check end-to-end on all your devices to ensure that all events are fully saved. So that it is possible to schedule an event and all the tool calls and all the large language models and feedback of those errors are probably properly identifying and telling the operator whether it's AI or human what exactly is wrong.",
	},
	{
		id: "default-template-rules",
		before:
			"Here is how it was supposed to work First you have a default user which named system or named default template, whatever And this user template should be loaded if the user does not have a template yet But if the system is initiated for the first time and there is no template, there should be created an empty template for the system user Each time we modify the system template, any new user that is having a document being created will have that system template as a start",
		after:
			'Here is how it was supposed to work:\n\n* You have a default user (named "system" or "default template", whatever).\n* This user template should be loaded if the user does not have a template yet.\n* If the system is initiated for the first time and there is no template, there should be created an empty template for the system user.\n* Each time we modify the system template, any new user that is having a document being created will have that system template as a start.',
	},
	{
		id: "config-tabs-especially",
		before:
			"I'm thinking on ways to reorganize the content of the tabs especially some AI sections are included in defaults and WhatsApp API got the AI tools in there and working hours have some working hours section and settings while event durations are in display and views Stuff is messed up and isn't organized. Please scan all the content of the configuration page and see how we should organize them",
		after:
			"I'm thinking on ways to reorganize the content of the tabs, especially:\n\n* Some AI sections are included in defaults\n* WhatsApp API got the AI tools in there\n* Working hours have some working hours section and settings\n* Event durations are in display and views\n\nStuff is messed up and isn't organized. Please scan all the content of the configuration page and see how we should organize them.",
	},
	{
		id: "model-fallback-steps",
		before:
			"One. Select a model using the main model that is the same as the fallback model that is already enabled and selected. Second, the fallback model correctly turns into auto. Third, select auto as the main mode, then first problem is that the model the save button isn't being disabled second the",
		after:
			'1. Select a model using the main model that is the same as the fallback model that is already enabled and selected.\n2. The fallback model correctly turns into "auto".\n3. Select "auto" as the main mode.\n\nFirst problem is that the model the save button isn\'t being disabled. Second, the',
	},
	{
		id: "shared-hooks-inventory",
		before:
			"Look this up also in the configuration page and make sure they are using the shared hooks slot duration day of the week total max per slot, pair type limits, duration mode, time format, default view, text direction, locale data type inside the table columns tab and stuff like time zone and any else anything else that you could find",
		after:
			"Look this up also in the configuration page and make sure they are using the shared hooks:\n\n* Slot duration\n* Day of the week\n* Total max per slot\n* Pair type limits\n* Duration mode\n* Time format\n* Default view\n* Text direction\n* Locale data type\n\nInside the table columns tab, and stuff like time zone and any else that you could find.",
	},
	{
		id: "approximate-equal-no-change",
		before:
			"This might be due to approximate equal true. Approximate equal true should only run when not in weak grid view inside the calendar. Only in that case we are approximating the nearest slot in order to reserve it. Otherwise, for the agent or for any other view, this should not happen.",
		after:
			"This might be due to approximate equal true. Approximate equal true should only run when not in weak grid view inside the calendar. Only in that case we are approximating the nearest slot in order to reserve it. Otherwise, for the agent or for any other view, this should not happen.",
	},
	{
		id: "drag-drop-question",
		before:
			"okay i need to know when drag dropping an event inside the slot inside the calendar does the event keep its minutes or does the minute go away and if the slot doesn't have any reservations forget about the slot organization in the UI but what happens in the database when you drag and drop an event into a slot that doesn't have any reservations yet",
		after:
			"Okay, I need to know when drag dropping an event inside the slot inside the calendar, does the event keep its minutes, or does the minute go away? And if the slot doesn't have any reservations, forget about the slot organization in the UI. But what happens in the database when you drag and drop an event into a slot that doesn't have any reservations yet?",
	},
	{
		id: "three-sources-list",
		before:
			"There are three sources that you could know the time of the event from. First of all the context window, second is the event time inside the event text itself and third from the data grid, when you did click a cell inside the calibrator. All of these needs to point at the same time. Currently Some of them do and some of them don't. You need to examine how all of them treat the data coming from the database.",
		after:
			"There are three sources that you could know the time of the event from:\n\n1. The context window\n2. The event time inside the event text itself\n3. From the data grid, when you did click a cell inside the calibrator\n\nAll of these need to point at the same time. Currently, some of them do, and some of them don't. You need to examine how all of them treat the data coming from the database.",
	},
	{
		id: "numbers-and-math",
		before: "one plus one equals two and fifty percent of twenty is ten",
		after: "1 + 1 = 2, and 50% of 20 is 10.",
	},
];

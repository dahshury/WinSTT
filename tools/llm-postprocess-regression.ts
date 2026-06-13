import {
	buildSystemPrompt,
	type PresetEntry,
} from "../src/shared/lib/preset-prompts";

interface RegressionCase {
	id: string;
	before: string;
	after: string;
}

interface CapabilityCheck {
	description: string;
	expected: string;
	pass: (text: string) => boolean;
}

interface CapabilityGapCase {
	id: string;
	before: string;
	profiles?: readonly string[];
	checks: readonly CapabilityCheck[];
}

interface PresetProfile {
	id: string;
	presets: readonly PresetEntry[];
}

const PRESETS: readonly PresetEntry[] = [
	{ key: "neutral" },
	{ key: "restructure" },
	{ key: "rewordForClarity" },
];

const REVIEW_MODE = process.argv.includes("--review");
const CAPABILITY_GAPS_MODE = process.argv.includes("--capability-gaps");

const BASE_USER_CLEANUP =
	'First apply base cleanup: fix punctuation, capitalization, grammar, spelling, spacing, and sentence boundaries; split run-on speech into natural sentences and keep dictated questions as questions; convert spoken numbers, dates, times, currency, percentages, units, versions, and equations to figures and symbols (for example, "one" -> "1", "twenty five dollars" -> "$25", "one percent" -> "1%", "one plus one equals two" -> "1 + 1 = 2"); preserve compact product/model/API/release version labels, keeping v plus a number joined and normalizing model/release "version N" to vN when clearly part of a name; convert spoken flags and separators inside code, command lines, URLs, file paths, email addresses, identifiers, and sensitive values to literal characters while preserving the spoken flag form (for example, "dash dash save" -> "--save", "dash m" -> "-m", and "c colon backslash temp backslash logs" -> "C:\\\\temp\\\\logs" in the final text for a backslash-based path) without masking the value; if the whole dictation is a bare email, URL, file path, command, code token, identifier, or field value, return only that literal after separator conversion without prose casing or terminal punctuation; never canonicalize, alias, or expand short CLI flags into long aliases (for example, "git commit dash m" must stay "git commit -m", not "git commit --message"); quote literal labels, values, error messages, and quote/unquote text, keeping punctuation outside quoted literals unless it was part of the literal; remove fillers, repeats, false starts, and adjacent restatements where a later clause replaces earlier words; later means the second or last adjacent alternative, never the first; when the same action, field, sentence frame, or predicate repeats back-to-back with a different subject, object, or value, keep only the later one unless additive wording clearly asks for both; abstract pattern: old value plus repeated frame followed immediately by new value plus same repeated frame means keep only the new-value frame; if both adjacent alternatives remain in the output, fix it before returning; the earlier replaced value is not a separate idea to preserve, even when it is a name, role, team, product, or other durable term; preserve the speaker\'s meaning and every idea.';

const CAPABILITY_GAP_PROFILES: readonly PresetProfile[] = [
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

const CAPABILITY_GAP_CASES: readonly CapabilityGapCase[] = [
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

const CASES: readonly RegressionCase[] = [
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
		id: "slot-capacity-error",
		before:
			"the limit on how many events are gonna slot accommodates is wrong. it seems to think that there is a hard limit of 3 events per slot even though I'm high-dropping inside the slot, I'm encountering, the slot cannot accommodate more events error although in the configuration i have configured the secretary slash ui to be a higher number it seems like the event capacity isn't adapting to the configuration I have configured inside the config",
		after:
			"the limit on how many events are going to slot accommodates is wrong. It seems to think that there is a hard limit of 3 events per slot, even though I'm high-dropping inside the slot. I'm encountering the \"slot cannot accommodate more events\" error, although in the configuration, I have configured the secretary/ui to be a higher number. It seems like the event capacity isn't adapting to the configuration I have configured inside the config.",
	},
	{
		id: "pending-working-hours",
		before:
			"whenever we open the configuration page i find there are pending 16 working hours tab changes this is probably due to the custom edges that we added an auto clean that should happen whenever we launch the configuration page well the auto clean never happens because whenever we launch it again again i see the number 16 of the day specific working hours changes and the problem persists",
		after:
			"Whenever we open the configuration page, I find there are pending 16 working hours tab changes. This is probably due to the custom edges that we added. An auto-clean that should happen whenever we launch the configuration page well, the auto-clean never happens because whenever we launch it again, I see the number 16 of the day specific working hours changes, and the problem persists.",
	},
	{
		id: "notification-routing",
		before:
			"There are local operations which are done inside the friend Such as sending a message, modifying, canceling or making new reservations For all of these there shouldn't be a notification but there should be a toast Currently we have both But for the AI agent initiated operations Which happen still using the same commands Somehow we should recognize them differently These should emit both notifications and toasts Also, the incoming messages from the system agent or from us Sending messages to the system agent should not trigger any notifications What should actually trigger notifications is incoming messages from users that talk through to the AI",
		after:
			"there are local operations which are done inside the friend, such as sending a message, modifying, canceling, or making new reservations. For all of these, there shouldn't be a notification, but there should be a toast. Currently, we have both. But for the AI agent-initiated operations, which happen still using the same commands, we somehow should recognize them differently. These should emit both notifications and toasts. Also, the incoming messages from the system agent or from us sending messages to the system agent should not trigger any notifications. What should actually trigger notifications is incoming messages from users that talk through to the AI.",
	},
	{
		id: "contacts-empty-state",
		before:
			"when no contacts are found or the filters didn't have any results the area that displays the contacts should not be empty it should have an empty state instead I think we already have an empty state but if we don't you can create one and use it for less",
		after:
			"When no contacts are found or the filters didn't have any results, the area that displays the contacts should not be empty. It should have an empty state instead. I think we already have an empty state, but if we don't, you can create one and use it for this.",
	},
	{
		id: "timezone-auto-button",
		before:
			" Next to the word timezone above the combo box for selection of the timezone inside the config page I want a small button that is called auto that based on the selected country would automatically select the timezone for that country if that button is pressed you can use any external library to do the mapping instead of doing it manually",
		after:
			'Next to the word timezone above the combo box for selection of the timezone inside the config page, I want a small button that is called "Auto". When pressed, it should automatically select the timezone for the selected country. You can use any external library to do the mapping instead of doing it manually.',
	},
	{
		id: "arabic-english-search",
		before:
			"oh i realized when i type in Arabic and then select one of the search results in English the text inside the search changes to English because i selected an English text and that retriggers another search which shows the drop down again or the select component again that's why for me it wasn't closing at least so this one",
		after:
			"Oh, I realized when I type in Arabic and then select one of the search results in English, the text inside the search changes to English because I selected an English text, and that retriggers another search which shows the dropdown again or the select component again. That's why for me it wasn't closing at least. So, this one.",
	},
	{
		id: "tooltip-label",
		before: "Please remove the tooltip above the pin that says drag",
		after: 'Please remove the tooltip above the pin that says "Drag".',
	},
	{
		id: "chat-drag-drop-availability",
		before:
			"The drag and drop flow that allows us to drag drop reservations from the calendar into the chat area for reference. I want the drag drop flow to not change the chat area shape if the chat area is indicating that the conversation has passed 24 hours so we cannot message the customer or if the customer has not sent messages yet. In other words, it should not be displayed when the chat isn't available.",
		after:
			"The drag and drop flow that allows us to drag-drop reservations from the calendar into the chat area for reference. I want the drag-drop flow to not change the chat area shape if the chat area is indicating that the conversation has passed 24 hours and we cannot message the customer, or if the customer has not sent messages yet. In other words, it should not be displayed when the chat isn't available.",
	},
	{
		id: "data-grid-unsafe-warning",
		before:
			"when modifying using the data grid that appears by date clicking a date inside the calendar when modifying the name or the phone of the user a warning dialog that is similar to the unsafe changes dialog should appear because modifying those will modify the users data if the user accepts then the save button will be enabled.",
		after:
			'When modifying using the data grid that appears by date, clicking a date inside the calendar, when modifying the name or the phone of the user, a warning dialog that is similar to the "unsafe changes" dialog should appear because modifying those will modify the user\'s data. If the user accepts, then the save button will be enabled.',
	},
	{
		id: "search-highlight-percentage",
		before:
			"From my understanding and confirm if I'm wrong all results since they have percentage they all should be matching some words by the query these matched words should be highlighted on a color but currently it's not because they are highlighted in a color that doesn't show because the first result is always highlighted well but subsequent results don't have any highlights at all",
		after:
			"From my understanding, and confirm if I'm wrong, all results since they have percentage should be matching some words by the query. These matched words should be highlighted on a color, but currently it's not because they are highlighted in a color that doesn't show. The first result is always highlighted well, but subsequent results don't have any highlights at all.",
	},
	{
		id: "embedding-cost-tokenlens",
		before:
			"In the configuration page, in the AI assistance section, below the embedding model, there is a search that you can put a word in and it tests the embedding of the model against what is inside the database. Given that the model in the Model Selector have a token per million cost we have a way to calculate the cost now. I want for each query in the bottom card just below the search where the search results time and the number of documents is and the number of results inside this card I want you also to include the cost there based on that. We have token LENS, you can look up their documentation they might help in that or you could calculate the cost in any other way you see fit.",
		after:
			"In the configuration page, in the AI assistance section, below the embedding model, there is a search that you can put a word in and it tests the embedding of the model against what is inside the database. Given that the model in the Model Selector has a token per million cost, we have a way to calculate the cost now. I want for each query in the bottom card just below the search where the search results time and the number of documents is and the number of results inside this card, I want you also to include the cost there based on that. We have TokenLens, you can look up their documentation; they might help in that or you could calculate the cost in any other way you see fit.",
	},
	{
		id: "shape-style-button",
		before:
			"is this button at the bottom that allows us to select the colors of the strokes and choose the UI how would the rectangles and other shapes will look like. the background of that isn't rendering it is disappearing please restore it",
		after:
			"is this button at the bottom that allows us to select the colors of the strokes and choose the UI? How would the rectangles and other shapes look like? The background of that isn't rendering, it is disappearing. Please restore it.",
	},
	{
		id: "mute-system-audio",
		before:
			"the mute system audio settings inside the recording section inside the settings is not working correctly. It does mute the sound, but upon release of the push to talk toggle or that stopping the dictation all together in either mode, it doesn't come back to the audio level that it was, so it just permanently The mute system audio settings inside the recording section inside the settings is not working correctly. It does mute the sound, but upon release of the Push to Talk toggle, or the stopping the dictation altogether in either mode, it doesn't come back to the audio level that it was. So it just permanently mutes the user's audio unless a user starts modifying the audio again. This should be fixed.",
		after:
			"The mute system audio settings inside the recording section inside the settings is not working correctly. It does mute the sound, but upon release of the Push to Talk toggle, or stopping the dictation altogether in either mode, it doesn't come back to the audio level that it was. So it just permanently mutes the user's audio unless a user starts modifying the audio again. This should be fixed.",
	},
	{
		id: "recording-mode-colors",
		before:
			"Let's beautify the frontend a little bit. The Recording mode which is either Push to Talk, Toggle or Listen should be reflected on the main page of the application and also reflected on the icon inside the Taskbar. Currently the icon inside the Taskbar fills with green whenever speaking. If speaking in toggle mode, the icon should be filled in yellow instead of green. Also inside the main page of the application, the toggle mode should dictate the color of the text that is written inside of the microphone. Also the text and color of the recording mode options inside the setting should be blue for push to talk yellow for toggle and green for listen these colors should be the ones reflected in everywhere whether inside the taskbar icon or inside the microphone in the main window or in the settings options of the recording",
		after:
			"Let's beautify the frontend a little bit. The Recording mode, which is either Push to Talk, Toggle, or Listen, should be reflected on the main page of the application and also reflected on the icon inside the Taskbar. Currently, the icon inside the Taskbar fills with green whenever speaking. If speaking in toggle mode, the icon should be filled in yellow instead of green. Also, inside the main page of the application, the toggle mode should dictate the color of the text that is written inside of the microphone. Also, the text and color of the recording mode options inside the settings should be:\n\n* blue for Push to Talk\n* yellow for Toggle\n* green for Listen\n\nThese colors should be the ones reflected everywhere, whether inside the Taskbar icon, inside the microphone in the main window, or in the settings options of the recording.",
	},
	{
		id: "numbers-and-math",
		before: "one plus one equals two and fifty percent of twenty is ten",
		after: "1 + 1 = 2, and 50% of 20 is 10.",
	},
];

// TS mirror of the Rust runtime normalizer `explode_inline_lists`
// (src-tauri/src/winstt/llm/normalize.rs). Applied here so --review shows what
// the app actually pastes after layout normalization. Keep the two in sync.
function explodeInlineLists(text: string): string {
	return text.split("\n").map(explodeLine).join("\n");
}

function explodeLine(line: string): string {
	return explodeNumbered(line) ?? explodeBulleted(line) ?? line;
}

function explodeNumbered(line: string): string | null {
	const markers: Array<{ start: number; contentStart: number; num: number }> =
		[];
	const re = /(\d{1,3})[.)]\s+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		markers.push({
			start: m.index,
			contentStart: m.index + m[0].length,
			num: Number(m[1]),
		});
	}
	const run: typeof markers = [];
	for (const mk of markers) {
		if (mk.num === run.length + 1) run.push(mk);
		else if (mk.num === 1) run.splice(0, run.length, mk);
	}
	if (run.length < 2) return null;
	const leadIn = line.slice(0, run[0]!.start).replace(/\s+$/, "");
	const parts: string[] = [];
	if (leadIn) parts.push(leadIn + (leadIn.endsWith(":") ? "\n" : ""));
	run.forEach((mk, idx) => {
		const end = idx + 1 < run.length ? run[idx + 1]!.start : line.length;
		parts.push(`${mk.num}. ${line.slice(mk.contentStart, end).trim()}`);
	});
	return parts.join("\n");
}

function explodeBulleted(line: string): string | null {
	const starts: number[] = [];
	for (let i = 0; i + 1 < line.length; i++) {
		const isMarker =
			(line[i] === "*" || line[i] === "-") && line[i + 1] === " ";
		const atBoundary = i === 0 || line[i - 1] === " ";
		if (isMarker && atBoundary) {
			starts.push(i);
			i += 1;
		}
	}
	if (starts.length < 2) return null;
	const leadIn = line.slice(0, starts[0]).replace(/\s+$/, "");
	const parts: string[] = [];
	if (leadIn) parts.push(leadIn + (leadIn.endsWith(":") ? "\n" : ""));
	starts.forEach((start, idx) => {
		const end = idx + 1 < starts.length ? starts[idx + 1]! : line.length;
		parts.push(`* ${line.slice(start + 2, end).trim()}`);
	});
	return parts.join("\n");
}

function normalize(text: string): string {
	return explodeInlineLists(text.replace(/\r\n/g, "\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function selectedCases(): readonly RegressionCase[] {
	const idsArg = process.argv.find((arg) => arg.startsWith("--ids="));
	if (!idsArg) return CASES;
	const ids = new Set(
		idsArg
			.slice("--ids=".length)
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean),
	);
	return CASES.filter((testCase) => ids.has(testCase.id));
}

function selectedCapabilityCases(): readonly CapabilityGapCase[] {
	const idsArg = process.argv.find((arg) => arg.startsWith("--ids="));
	if (!idsArg) return CAPABILITY_GAP_CASES;
	const ids = new Set(
		idsArg
			.slice("--ids=".length)
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean),
	);
	return CAPABILITY_GAP_CASES.filter((testCase) => ids.has(testCase.id));
}

function selectedProfiles(): readonly PresetProfile[] {
	const profilesArg = process.argv.find((arg) => arg.startsWith("--profiles="));
	if (!profilesArg) return CAPABILITY_GAP_PROFILES;
	const ids = new Set(
		profilesArg
			.slice("--profiles=".length)
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean),
	);
	return CAPABILITY_GAP_PROFILES.filter((profile) => ids.has(profile.id));
}

function caseAppliesToProfile(
	testCase: CapabilityGapCase,
	profile: PresetProfile,
): boolean {
	return !testCase.profiles || testCase.profiles.includes(profile.id);
}

function operationSummary(entry: PresetEntry): string | null {
	if ("id" in entry) {
		const label = entry.name.trim() || "custom modifier";
		return `apply the custom modifier "${label}" while preserving durable names, literal values, and identifiers`;
	}
	switch (entry.key) {
		case "neutral":
			return null;
		case "formal":
			return "rewrite in a polished, formal, professional tone";
		case "friendly":
			return "visibly rewrite in a warmer, friendly, conversational tone";
		case "technical":
			return "rewrite with precise technical terminology and rigorous structure while preserving product/model names, compact version labels, code identifiers, and literal values";
		case "concise":
			return "make the text concise while preserving every important idea";
		case "summarize":
			return "shorten lightly while preserving the key points, durable names, literal values, and point of view";
		case "reorder":
			return "reorder for logical flow only when it improves the sequence while keeping all content";
		case "restructure":
			return "actively structure announced counts, ordered steps, parallel items, inventories, and label-value mappings into numbered or `* ` bullet lists with the lead-in kept as prose, ending each list where the speech moves to a new topic, and keeping everything else prose";
		case "rewordForClarity":
			return "visibly rewrite unclear or awkward phrasing into clearer natural language while preserving meaning, point of view, names, literal values, and trailing fragments";
		case "translate": {
			const target = entry.targetLang?.trim() || "English";
			return `translate the final result into ${target} while preserving people names, organization names, product names, project names, app names, code, command lines, URLs, file paths, email addresses, identifiers, and quoted UI labels exactly unless the quoted text is ordinary prose being translated; button, menu, mode, value, and error labels introduced by phrases like "button says" or "labeled" must still be in quote marks after translation`;
		}
	}
}

function buildUserPromptForPresets(
	before: string,
	presets: readonly PresetEntry[],
): string {
	const operations = presets
		.map(operationSummary)
		.filter((value): value is string => value !== null);
	if (operations.length === 0) {
		return [
			BASE_USER_CLEANUP,
			"Before returning, check that adjacent self-correction alternatives keep only the later restatement.",
			"Transform the following text according to the style guide above. Return ONLY the transformed text with no commentary, explanations, labels, or JSON formatting.",
			"",
			`Text to transform:\n${before}`,
		].join("\n");
	}
	const opLabel =
		operations.length === 1 ? "Active operation" : "Active operations";
	return [
		BASE_USER_CLEANUP,
		`${opLabel} to apply exactly: ${operations.join("; ")}.`,
		"Apply the active operation visibly unless the input is empty or pure noise. Before returning, do a final check: durable names, literal quoted text, code, command lines, URLs, file paths, email addresses, identifiers, and the speaker's meaning are preserved, except earlier adjacent self-correction alternatives that were replaced by a later restatement; run-on sentences are split; no markdown emphasis or highlighting is added unless explicitly dictated.",
		"Transform the following text according to the style guide above and these active operations. Return ONLY the transformed text with no commentary, explanations, labels, or JSON formatting.",
		"",
		`Text to transform:\n${before}`,
	].join("\n");
}

// Mirrors the runtime user prompt composed by `active_modifier_user_prompt`
// in src-tauri/src/winstt/llm/prompts.rs for [restructure, rewordForClarity],
// including the synthetic restructure pattern demos (small models apply
// formatting patterns far more reliably from compact demos near the end of the
// USER prompt than from rules in the system prompt). Keep the two in sync;
// everything here must stay general — no case-specific phrases lifted from the
// regression inputs.
function buildUserPrompt(before: string): string {
	return [
		BASE_USER_CLEANUP,
		"Active operations to apply exactly: actively structure announced counts, ordered steps, parallel items, inventories, and label-value mappings into numbered or `* ` bullet lists with the lead-in kept as prose, ending each list where the speech moves to a new topic, and keeping everything else prose; visibly rewrite unclear or awkward phrasing into clearer natural language, fixing obvious wrong-word slips and vague placeholders while preserving meaning, point of view, and trailing fragments.",
		'Format every list with REAL line breaks (newline characters in the `text` value): each numbered item or bullet on its own line, and a blank line before the first item and after the last item. Never put list items on one line separated by spaces. Patterns to apply wherever the text matches them: "You should update the docs, fix the tests and ping the team." -> "You should:\n\n* update the docs\n* fix the tests\n* ping the team" "The status should be red for errors, yellow for warnings and green for success." -> "The status should be:\n\n* red for errors\n* yellow for warnings\n* green for success" "One. Open the settings. Second, change the language. Third, restart the app, then the first issue is that the language resets." -> "1. Open the settings.\n2. Change the language.\n3. Restart the app.\n\nThe first issue is that the language resets."',
		"Apply the active operations visibly unless the input is empty or pure noise. Before returning, do a final check: no sentence, item, or action from the input is missing except earlier adjacent self-correction alternatives that were replaced by a later restatement; announced counts and ordered steps are formatted as numbered lists with each item on its own line; parallel items and label-value mappings are `* ` bullets; every list has a blank line before and after it; literal labels and values are quoted; intent framing and trailing fragments are preserved; run-on sentences are split.",
		"Transform the following text according to the style guide above and these active operations. Return ONLY the transformed text with no commentary, explanations, labels, or JSON formatting.",
		"",
		`Text to transform:\n${before}`,
	].join("\n");
}

const TEXT_SCHEMA = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
	additionalProperties: false,
} as const;

async function callOllama(
	system: string,
	userPrompt: string,
	id: string,
): Promise<string> {
	const endpoint = process.env.OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434";
	const model = process.env.OLLAMA_MODEL ?? "gemma4:e4b";
	const numCtx = Number(process.env.OLLAMA_NUM_CTX ?? 16384);
	const response = await fetch(`${endpoint}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: userPrompt },
			],
			stream: false,
			think: false,
			format: TEXT_SCHEMA,
			options: { temperature: 0, num_ctx: numCtx, num_predict: 8192 },
		}),
	});
	if (!response.ok) {
		throw new Error(
			`${id}: Ollama HTTP ${response.status} ${await response.text()}`,
		);
	}
	const data = await response.json();
	const raw = data.message?.content ?? "";
	return (JSON.parse(raw) as { text: string }).text;
}

async function callOpenRouter(
	system: string,
	userPrompt: string,
	id: string,
): Promise<string> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey)
		throw new Error(
			"OPENROUTER_API_KEY is required for the openrouter provider",
		);
	const model = process.env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite";
	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: userPrompt },
				],
				temperature: 0,
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "cleaned_text",
						strict: true,
						schema: TEXT_SCHEMA,
					},
				},
			}),
		},
	);
	if (!response.ok) {
		throw new Error(
			`${id}: OpenRouter HTTP ${response.status} ${await response.text()}`,
		);
	}
	const data = await response.json();
	const raw = data.choices?.[0]?.message?.content ?? "";
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error(
			`${id}: OpenRouter empty content: ${JSON.stringify(data).slice(0, 400)}`,
		);
	}
	return extractText(raw);
}

/** Pull the transformed text out of a model response. Structured-output models
 *  return `{"text": "..."}`, but gemini-flash-lite occasionally wraps that in a
 *  ```json fence or returns the cleaned text directly — tolerate all three so a
 *  single stray response doesn't abort the whole run. */
function extractText(raw: string): string {
	const unfenced = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	try {
		const parsed = JSON.parse(unfenced) as { text?: unknown };
		if (parsed && typeof parsed.text === "string") return parsed.text;
	} catch {
		// Not JSON — fall through and treat the (unfenced) content as the text.
	}
	return unfenced;
}

const PROVIDER =
	process.env.PROVIDER ??
	(process.env.OPENROUTER_API_KEY ? "openrouter" : "ollama");

async function runCase(testCase: RegressionCase, system: string) {
	const userPrompt = buildUserPrompt(testCase.before);
	const text =
		PROVIDER === "openrouter"
			? await callOpenRouter(system, userPrompt, testCase.id)
			: await callOllama(system, userPrompt, testCase.id);
	const actual = normalize(text);
	const expected = normalize(testCase.after);
	return { actual, expected, pass: actual === expected };
}

async function runCapabilityGapCase(
	testCase: CapabilityGapCase,
	profile: PresetProfile,
) {
	const system = buildSystemPrompt(profile.presets);
	const userPrompt = buildUserPromptForPresets(
		testCase.before,
		profile.presets,
	);
	const text =
		PROVIDER === "openrouter"
			? await callOpenRouter(system, userPrompt, `${profile.id}:${testCase.id}`)
			: await callOllama(system, userPrompt, `${profile.id}:${testCase.id}`);
	const actual = normalize(text);
	const failures = testCase.checks.filter((check) => !check.pass(actual));
	return { actual, failures, pass: failures.length === 0 };
}

if (process.argv.includes("--selftest")) {
	const samples = [
		"There are local operations which are done inside the frontend: 1. Sending a message. 2. Modifying reservations. 3. Canceling reservations. 4. Making new reservations. For all of these, there should not be a notification.",
		"You should: * update the docs * fix the tests * ping the team",
		"This is plain prose with no list at all.",
	];
	for (const s of samples) {
		console.log("IN :", JSON.stringify(s));
		console.log("OUT:", JSON.stringify(normalize(s)));
		console.log("---");
	}
	process.exit(0);
}

const MODEL_LABEL =
	PROVIDER === "openrouter"
		? (process.env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite")
		: (process.env.OLLAMA_MODEL ?? "gemma4:e4b");

if (CAPABILITY_GAPS_MODE) {
	const cases = selectedCapabilityCases();
	const profiles = selectedProfiles();
	const totalRuns = profiles.reduce(
		(total, profile) =>
			total +
			cases.filter((testCase) => caseAppliesToProfile(testCase, profile))
				.length,
		0,
	);
	const failures: Array<{
		id: string;
		profile: string;
		actual: string;
		checks: readonly CapabilityCheck[];
	}> = [];
	console.log(
		`Running ${totalRuns} capability-gap run(s) from ${cases.length} case(s) across ${profiles.length} preset profile(s). Provider=${PROVIDER} (${MODEL_LABEL}). Mode=${
			REVIEW_MODE ? "semantic-review" : "assertions"
		}.`,
	);
	for (const profile of profiles) {
		for (const testCase of cases) {
			if (!caseAppliesToProfile(testCase, profile)) continue;
			const result = await runCapabilityGapCase(testCase, profile);
			const label = `${profile.id}:${testCase.id}`;
			if (REVIEW_MODE) {
				console.log(`\n[${label}] actual:\n${result.actual}`);
				if (result.failures.length > 0) {
					console.log(
						`failed checks: ${result.failures
							.map((check) => check.expected)
							.join("; ")}`,
					);
				}
			} else if (result.pass) {
				console.log(`PASS ${label}`);
			} else {
				console.log(`FAIL ${label}`);
				failures.push({
					id: testCase.id,
					profile: profile.id,
					actual: result.actual,
					checks: result.failures,
				});
			}
		}
	}
	if (REVIEW_MODE) {
		console.log("\nCapability-gap semantic review run complete.");
		process.exit(0);
	}
	if (failures.length > 0) {
		console.log("\nCapability-gap failures:");
		for (const failure of failures) {
			console.log(`\n[${failure.profile}:${failure.id}]`);
			console.log(
				`missing/failed: ${failure.checks
					.map((check) => check.expected)
					.join("; ")}`,
			);
			console.log(`actual:\n${failure.actual}`);
		}
		process.exit(1);
	}
	console.log("All capability-gap regression checks passed.");
	process.exit(0);
}

const system = buildSystemPrompt(PRESETS);
const cases = selectedCases();
const failures: Array<{ id: string; actual: string; expected: string }> = [];
console.log(
	`Running ${cases.length} post-processing regression case(s). Provider=${PROVIDER} (${MODEL_LABEL}). Prompt chars=${system.length}. Mode=${
		REVIEW_MODE ? "semantic-review" : "exact"
	}.`,
);

for (const testCase of cases) {
	const result = await runCase(testCase, system);
	if (REVIEW_MODE) {
		console.log(
			`\n[${testCase.id}] target vibe:\n${result.expected}\n\nactual:\n${result.actual}`,
		);
	} else if (result.pass) {
		console.log(`PASS ${testCase.id}`);
	} else {
		console.log(`FAIL ${testCase.id}`);
		failures.push({
			id: testCase.id,
			actual: result.actual,
			expected: result.expected,
		});
	}
}

if (REVIEW_MODE) {
	console.log(
		"\nSemantic review run complete. Review actual outputs against target vibes above.",
	);
	process.exit(0);
}

if (failures.length > 0) {
	console.log("\nFailures:");
	for (const failure of failures) {
		console.log(
			`\n[${failure.id}] expected:\n${failure.expected}\n\nactual:\n${failure.actual}`,
		);
	}
	process.exit(1);
}

console.log("All post-processing regression cases passed.");

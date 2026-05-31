/**
 * App registry for the context-awareness harness.
 *
 * Each entry describes how to drive a real web app into the state dictation
 * cares about — caret in the reply/compose field, with the thing the user is
 * "acting on" (email, message thread, tweet, post) visible above it — so the
 * native UIA capture sees exactly what it would during a real dictation.
 *
 * `focus(page)` runs against a Page already navigated to `url`; it must leave DOM
 * focus in the compose field. `composeSelector` is the FINAL compose field —
 * capture.ts's ensureComposeFocused re-clicks + DOM-.focus()es it right before
 * the UIA read (the navigation recipe's focus is often lost to a re-render by
 * then; Lexical/Draft editors don't focus on click alone). Throwing from focus()
 * marks the app focus-failed but the capture still runs.
 *
 * Selectors are DOM-VERIFIED live (throwaway CDP inspector) — apps obfuscate
 * classes + change structure. WEB-only (Playwright/CDP); native desktop apps are
 * a later phase. See memory/project_context_harness.md.
 */
import type { Page } from "playwright";

export interface HarnessApp {
	/** CSS selector for the compose field — re-focused + verified before the read. */
	readonly composeSelector: string;
	/** Substring expected in the captured windowTitle (lowercased) — verifies the
	 *  right window was foreground when the native helper ran. */
	readonly expectWindowTitleIncludes: string;
	/** Drive the page into "caret in the compose field" state. */
	focus(page: Page): Promise<void>;
	/** Stable id — also the output subfolder name. */
	readonly id: string;
	/** Human label for logs/report. */
	readonly label: string;
	/** Where to navigate before focusing. */
	readonly url: string;
}

/** Click the first locator that exists + is visible, else throw. */
async function focusFirstVisible(page: Page, selectors: readonly string[]): Promise<void> {
	for (const selector of selectors) {
		const loc = page.locator(selector).first();
		// biome-ignore lint: await-in-loop is intentional — probe selectors in priority order.
		if (await loc.isVisible().catch(() => false)) {
			// biome-ignore lint: see above.
			await loc.click({ force: true });
			return;
		}
	}
	throw new Error(`none of the focus selectors matched: ${selectors.join(" | ")}`);
}

/** Gmail: open newest inbox thread, expand its reply composer, seat the caret. */
async function focusGmail(page: Page): Promise<void> {
	await page.waitForSelector("tr.zA span.bog", { timeout: 12_000 });
	await page.locator("tr.zA span.bog").first().click({ force: true });
	await page.waitForSelector("div.adn, div.gs, div.h7, div.nH .if", { timeout: 10_000 });
	await page.waitForTimeout(1000);
	await focusFirstVisible(page, [
		'span[role="link"]:has-text("Reply")',
		'div[role="button"][aria-label^="Reply"]',
		'span:has-text("Reply")',
	]);
	await page.waitForSelector('[aria-label="Message Body"][role="textbox"]', { timeout: 8000 });
	await page.locator('[aria-label="Message Body"][role="textbox"]').first().click();
}

/** Discord (web) 1:1 DM: open the most recent DM, seat the caret in the composer. */
async function focusDiscord(page: Page): Promise<void> {
	const firstDm = page.locator('a[href^="/channels/@me/"]').first();
	await firstDm.waitFor({ state: "visible", timeout: 12_000 });
	await firstDm.click();
	await page.waitForSelector('div[role="textbox"]', { timeout: 10_000 });
	await page.waitForTimeout(900);
	await focusFirstVisible(page, [
		'div[role="textbox"][aria-label^="Message"]',
		'div[role="textbox"][data-slate-editor="true"]',
		'div[role="textbox"]',
	]);
}

// User's "Project Bavard" server — used ONLY as a deterministic harness fixture
// when the rail scrape can't surface a guild snowflake (servers nested in
// collapsed folders, etc.). Debug tooling, not shipped.
const DISCORD_FALLBACK_GUILD_ID = "1497315608285544509";

/**
 * Read the first 17+ digit guild SNOWFLAKE from the rail (short numeric ids are
 * FOLDER ids, not guilds; non-numeric ids like `tutorial-container` are chrome).
 * If none surface, expand every collapsed folder nav item and re-scan. Returns
 * null when the rail exposes no real guild.
 */
async function scrapeGuildSnowflake(page: Page): Promise<string | null> {
	const readRail = () =>
		page.evaluate(() => {
			const items = Array.from(document.querySelectorAll('[data-list-item-id^="guildsnav___"]'));
			for (const el of items) {
				const m = (el.getAttribute("data-list-item-id") || "").match(/guildsnav___(\d{17,})/);
				if (m?.[1]) {
					return m[1];
				}
			}
			return null;
		});
	let guildId = await readRail();
	if (guildId) {
		return guildId;
	}
	// Servers may be tucked inside collapsed folders — expand each, then re-scan.
	const folders = page.locator('[data-list-item-id^="guildsnav___"][aria-expanded="false"]');
	const folderCount = await folders.count().catch(() => 0);
	for (let i = 0; i < folderCount; i++) {
		// biome-ignore lint: sequential folder expansion — must await each click.
		await folders
			.nth(i)
			.click()
			.catch(() => {});
		// biome-ignore lint: see above.
		await page.waitForTimeout(400);
	}
	guildId = await readRail();
	return guildId;
}

/** Count rendered chat messages in the currently-open Discord channel. */
function renderedMessageCount(page: Page): Promise<number> {
	return page
		.evaluate(() => document.querySelectorAll('li[id^="chat-messages-"]').length)
		.catch(() => 0);
}

/**
 * Discord server channel (multi-participant). Deterministic: scrape a real 17+
 * digit guild snowflake from the rail (expanding collapsed folders first), and
 * FALL BACK to the known fixture guild so this surface never depends on the
 * rail's current state. After landing on the bare guild URL the Message composer
 * is often absent (rules/onboarding view), so we walk the text-channel links
 * (`a[data-list-item-id^="channels___"]`) and stop on the FIRST channel whose
 * backlog actually renders messages — the leading channels are often empty
 * onboarding rooms (welcome/rules), so picking the first link alone captures
 * server chrome, not a conversation. The composer is the same role=textbox
 * aria-label "Message #channel" as the passing DM case; beforeCaret then carries
 * the channel's multi-author backlog.
 */
async function focusDiscordServer(page: Page): Promise<void> {
	await page.waitForSelector('[data-list-item-id^="guildsnav___"]', { timeout: 15_000 });
	await page.waitForTimeout(800);
	const guildId = (await scrapeGuildSnowflake(page)) ?? DISCORD_FALLBACK_GUILD_ID;
	await page
		.goto(`https://discord.com/channels/${guildId}`, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		})
		.catch(() => {});
	await page.waitForTimeout(2500);
	// Walk text channels; land on the first with a real (non-empty) backlog so the
	// capture is a conversation, not an empty onboarding room. Fall back to leaving
	// whatever channel is open if none render messages (still focuses a composer).
	const channels = page.locator(
		`a[data-list-item-id^="channels___"][href^="/channels/${guildId}/"]`
	);
	await channels
		.first()
		.waitFor({ state: "visible", timeout: 10_000 })
		.catch(() => {});
	const channelCount = await channels.count().catch(() => 0);
	for (let i = 0; i < channelCount; i++) {
		// biome-ignore lint: sequential channel probe — must await each click + settle.
		await channels
			.nth(i)
			.click({ force: true })
			.catch(() => {});
		// biome-ignore lint: see above.
		await page.waitForTimeout(1600);
		// biome-ignore lint: see above.
		if ((await renderedMessageCount(page)) > 0) {
			break;
		}
	}
	await page.waitForSelector('div[role="textbox"][aria-label^="Message"]', { timeout: 15_000 });
	await page.waitForTimeout(900);
	await focusFirstVisible(page, [
		'div[role="textbox"][aria-label^="Message"]',
		'div[role="textbox"][data-slate-editor="true"]',
		'div[role="textbox"]',
	]);
}

/** X/Twitter home composer ("What's happening?"). Logged-in only. */
async function focusX(page: Page): Promise<void> {
	await page.waitForSelector('[data-testid="tweetTextarea_0"], [data-testid="primaryColumn"]', {
		timeout: 20_000,
	});
	await page.waitForTimeout(1200);
	await focusFirstVisible(page, [
		'[data-testid="tweetTextarea_0"]',
		'div[role="textbox"][aria-label*="post" i]',
		'div[role="textbox"][contenteditable="true"]',
	]);
}

/** X reply: open the first timeline tweet (→ /status/…), seat the caret in the
 *  reply box (same tweetTextarea_0). beforeCaret carries the tweet being replied to. */
async function focusXReply(page: Page): Promise<void> {
	await page.waitForSelector('article[data-testid="tweet"]', { timeout: 20_000 });
	await page.locator('article[data-testid="tweet"]').first().click();
	await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15_000 });
	await page.waitForTimeout(900);
	await page.locator('[data-testid="tweetTextarea_0"]').first().click();
}

/** Facebook Messenger (facebook.com/messages): open a conversation, seat the
 *  caret in the composer (the single div[role=textbox][contenteditable], aria
 *  "Write to <name>"). */
async function focusFacebook(page: Page): Promise<void> {
	await page.waitForSelector('a[href*="/messages/t/"]', { timeout: 20_000 });
	await page.locator('a[href*="/messages/t/"]').first().click({ force: true });
	// Wait for the composer to actually mount (the 8-app sequential run raced past
	// it → focus-miss); only then seat the caret.
	await page.waitForSelector('div[role="textbox"][contenteditable="true"]', { timeout: 12_000 });
	await page.waitForTimeout(1500);
	await focusFirstVisible(page, [
		'div[role="textbox"][contenteditable="true"]',
		'[role="main"] div[contenteditable="true"]',
	]);
}

/** Facebook FEED comment: on the main feed, click the first post's comment
 *  placeholder ([aria-label="Leave a comment"]) to reveal + focus its composer
 *  (div[role=textbox] aria "Comment as <name>"). beforeCaret = the post + comments. */
async function focusFacebookFeed(page: Page): Promise<void> {
	await page.waitForSelector('[aria-label="Leave a comment"]', { timeout: 20_000 });
	await page.locator('[aria-label="Leave a comment"]').first().click({ force: true });
	// The composer's aria-label is the localized "Comment as <name>" / "Answer as
	// <name>", so match contenteditable rather than a fixed verb.
	await page.waitForSelector('div[role="textbox"][contenteditable="true"]', { timeout: 12_000 });
	await page.waitForTimeout(700);
	await focusFirstVisible(page, [
		'div[role="textbox"][aria-label^="Comment as"]',
		'div[role="textbox"][aria-label^="Answer as"]',
		'div[role="textbox"][contenteditable="true"]',
	]);
}

/**
 * WhatsApp Web: chat rows are div[role="row"] inside div[role="grid"] (the old
 * #pane-side div[role=listitem] is gone). The list downloads after login so wait
 * generously; the composer only mounts after a chat opens.
 */
async function focusWhatsApp(page: Page): Promise<void> {
	await page.waitForSelector('div[role="grid"] div[role="row"]', { timeout: 60_000 });
	await page.waitForTimeout(800);
	await page.locator('div[role="grid"] div[role="row"]').first().click();
	await page.waitForSelector('div[contenteditable="true"][role="textbox"]', { timeout: 15_000 });
	await page.waitForTimeout(600);
	await focusFirstVisible(page, [
		'div[contenteditable="true"][role="textbox"][data-tab="10"]',
		'div[contenteditable="true"][role="textbox"]',
		"footer div[contenteditable='true']",
	]);
}

export const HARNESS_APPS: readonly HarnessApp[] = [
	{
		id: "gmail",
		label: "Gmail",
		url: "https://mail.google.com/mail/u/0/#inbox",
		expectWindowTitleIncludes: "gmail",
		composeSelector: '[aria-label="Message Body"][role="textbox"]',
		focus: focusGmail,
	},
	{
		id: "discord",
		label: "Discord (DM)",
		url: "https://discord.com/channels/@me",
		expectWindowTitleIncludes: "discord",
		composeSelector: 'div[role="textbox"][aria-label^="Message"]',
		focus: focusDiscord,
	},
	{
		id: "discord-server",
		label: "Discord (server)",
		url: "https://discord.com/channels/@me",
		expectWindowTitleIncludes: "discord",
		composeSelector: 'div[role="textbox"][aria-label^="Message"]',
		focus: focusDiscordServer,
	},
	{
		id: "x",
		label: "X (compose)",
		url: "https://x.com/home",
		expectWindowTitleIncludes: "/ x",
		composeSelector: '[data-testid="tweetTextarea_0"]',
		focus: focusX,
	},
	{
		id: "x-reply",
		label: "X (reply)",
		url: "https://x.com/home",
		expectWindowTitleIncludes: "x",
		composeSelector: '[data-testid="tweetTextarea_0"]',
		focus: focusXReply,
	},
	{
		id: "facebook",
		label: "Facebook Messenger",
		url: "https://www.facebook.com/messages/t/",
		expectWindowTitleIncludes: "messenger",
		composeSelector: 'div[role="textbox"][contenteditable="true"]',
		focus: focusFacebook,
	},
	{
		id: "facebook-feed",
		label: "Facebook (feed comment)",
		url: "https://www.facebook.com/",
		expectWindowTitleIncludes: "facebook",
		composeSelector: 'div[role="textbox"][contenteditable="true"]',
		focus: focusFacebookFeed,
	},
	{
		id: "whatsapp",
		label: "WhatsApp Web",
		url: "https://web.whatsapp.com/",
		expectWindowTitleIncludes: "whatsapp",
		composeSelector: 'div[contenteditable="true"][role="textbox"]',
		focus: focusWhatsApp,
	},
];

export const APPS_BY_ID: ReadonlyMap<string, HarnessApp> = new Map(
	HARNESS_APPS.map((app) => [app.id, app])
);

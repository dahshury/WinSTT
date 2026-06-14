#!/usr/bin/env node
/**
 * Lean CDP capture harness for WinSTT context-awareness re-verification.
 *
 * Playwright's connectOverCDP hangs against Chrome 149 (raw CDP is fine), so this
 * drives the DevTools Protocol directly via `ws`. For each app it:
 *   1. opens the app URL in its OWN new Chrome window (Target.createTarget newWindow),
 *   2. Page.bringToFront (forces the page "visible" so Chrome builds the web a11y
 *      tree — the missing ingredient vs. background tabs / UIA tab-select),
 *   3. runs the per-app focus recipe (seat the caret in the reply/compose field),
 *   4. resolves the Chrome window HWND by title (resolve-hwnd.ps1, occlusion-proof),
 *   5. runs the SAME native UIA helper dictation uses (winstt-context.exe --tree
 *      --hwnd) + --selection,
 *   6. pipes the snapshot through the Tauri analyzer (context_prompt_smoke) for the
 *      current-app verdict (replyContextReady / leaks / depth).
 *
 * Usage:  node tools/context-cdp-capture.mjs gmail discord x ...   (default: all)
 * Env:    CDP_PORT (default 9222)
 * Output: artifacts/context-cdp/<id>/{rawSnapshot.json, selection.json, smoke.json}
 *         + a top-level summary printed to stdout.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const execFileAsync = promisify(execFile);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.CDP_PORT ?? "9222";
const CONTEXT_EXE = path.join(REPO, "src-tauri", "target", "debug", "winstt_context.exe");
const SMOKE_EXE = path.join(REPO, "src-tauri", "target", "debug", "context_prompt_smoke.exe");
const RESOLVE_HWND = path.join(REPO, "tools", "windows", "resolve-hwnd.ps1");
const OUT = path.join(REPO, "artifacts", "context-cdp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Per-app recipes ────────────────────────────────────────────────────────
// focus: an async-IIFE expression string evaluated in the page (returns a small
// status object). Mirrors examples/.../context-harness/apps.ts selectors.
const FOCUS_HELPERS = `
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  async function waitFor(sel, ms){ const t=Date.now(); while(Date.now()-t<ms){ const el=document.querySelector(sel); if(el) return el; await sleep(150);} return null; }
  async function clickFirst(sels){ for(const s of sels){ const el=document.querySelector(s); if(el){ el.scrollIntoView&&el.scrollIntoView(); el.click(); return s; } } return null; }
  function focusEl(el){ if(!el) return false; el.focus(); try{ const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r);}catch(e){} return document.activeElement===el; }
`;

const APPS = {
	gmail: {
		label: "gmail",
		url: "https://mail.google.com/mail/u/0/#inbox",
		titleHint: "Gmail",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// NB: keep the cumulative waitFor budget well under the harness CDP 30s
			// evaluate timeout — the page is already loaded by the time this runs
			// (2.5s settle + ctx-recovery upstream), so short polls suffice and an
			// over-long recipe just times out (then only the ensure-focus salvages
			// composer focus, skipping the quote-expand → OTP leak).
			await waitFor('tr.zA', 6000);
			// Open an ACTUAL conversation: prefer a row whose subject starts with
			// Re:/Fwd: (a real back-and-forth thread → multi-speaker depth) over the
			// promo/OTP/verification rows that dominate this inbox (those poison the
			// capture with login-code noise + zero conversation). Fall back to row 0.
			const rows=[...document.querySelectorAll('tr.zA')];
			const subjOf=tr=>(((tr.querySelector('span.bog')||{}).textContent)||'').trim();
			const conv=rows.find(tr=>/^(re|fwd|aw|fw)\\s*:/i.test(subjOf(tr)))
				|| rows.find(tr=>!/(verification|one[- ]time|otp|password|sign[- ]?in|log ?in|secure link|authenticate|receipt|payment)/i.test(subjOf(tr)))
				|| rows[0];
			if(conv){ conv.scrollIntoView&&conv.scrollIntoView({block:'center'}); const open=conv.querySelector('span.bog')||conv; open.click(); }
			// wait for the email body to actually render before hunting for Reply.
			await waitFor('div[role=\\'listitem\\'], div.adn, div.a3s', 6000);
			// reading-pane Reply button is span.ams.bkH ("Reply"); it appears a few
			// seconds after the email opens — poll, and re-try the click once.
			let reply = await waitFor('span.ams.bkH', 8000);
			if(reply){ reply.click(); await sleep(500);
				if(!document.querySelector('[aria-label=\\'Message Body\\'][role=\\'textbox\\']')){ const r2=document.querySelector('span.ams.bkH'); if(r2) r2.click(); }
			}
			// Poll for the Message Body, then CLICK it before focusing — a bare
			// .focus() loses to Gmail's re-render and the caret ends up on the row
			// (active=TR); the click seats the caret reliably (verified active=Message Body).
			const body = await waitFor('[aria-label=\\'Message Body\\'][role=\\'textbox\\']', 6000);
			// Gmail inline reply box is EMPTY (quoted thread collapsed under the
			// .ajR / Show-trimmed-content toggle). With no field text the context
			// formatter dumps the WHOLE window tree as the screen section, which
			// drags in the inbox list verification/OTP rows (otp noise warning) and
			// gives zero conversation depth. Expanding the quote injects the real
			// back-and-forth INTO the composer so it becomes a rich field: the
			// formatter then emits a clean before-caret thread and prunes the inbox.
			// Verified: body length 0 to 589 with an On...wrote: quote.
			const trimmed = document.querySelector('.ajR[aria-label=\\'Show trimmed content\\'], .ajR');
			if(trimmed){ try{ trimmed.click(); }catch(e){} await sleep(700); }
			if(body){ body.scrollIntoView&&body.scrollIntoView({block:'center'}); body.click(); }
			return { focused: focusEl(body), replyFound: !!reply, expandedQuote: !!trimmed, opened: conv?subjOf(conv).slice(0,40):null };
		})()`,
	},
	discord: {
		label: "discord",
		url: "https://discord.com/channels/@me",
		titleHint: "Discord",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// (1) DISMISS the open-in-app / continue-in-browser interstitial FIRST —
			// root cause of the empty Discord captures. Poll up to 6s for an anchor or
			// button whose visible text matches /continue in browser/i and click it.
			const dismissInterstitial = ()=>{ const nodes=[...document.querySelectorAll('a[role=\\'button\\'],button,a')]; const hit=nodes.find(n=>/continue in browser/i.test((n.textContent||'').trim())); if(hit){ hit.click(); return true; } return false; };
			const tInt=Date.now(); let dismissed=false; while(Date.now()-tInt<6000){ if(dismissInterstitial()){ dismissed=true; await sleep(600); } if(document.querySelector('[data-list-item-id^=\\'guildsnav___\\']')||document.querySelector('a[href^=\\'/channels/@me/\\']')) break; await sleep(200); }
			// (2) require the guild rail OR a DM anchor before proceeding (Discord SPA is slow).
			await waitFor('[data-list-item-id^=\\'guildsnav___\\'], a[href^=\\'/channels/@me/\\']', 18000);
			if(/^\\/login/.test(location.pathname) || document.querySelector('form[class*=\\'authBox\\'], [class*=\\'loginForm\\']')) return { focusMiss: 'not-logged-in', dismissed };
			// (3) open the most-recent DM — pick an anchor with a NUMERIC channel id
			// (/channels/@me/<digits>), skipping the @me / Friends home link.
			const dms=[...document.querySelectorAll('a[href^=\\'/channels/@me/\\']')].filter(a=>/^\\/channels\\/@me\\/\\d+/.test(a.getAttribute('href')||''));
			const dm=dms[0]; if(dm) dm.click();
			// (4) wait for the rendered thread (message rows) BEFORE focusing — generous 18s poll.
			await waitFor('li[id^=\\'chat-messages-\\']', 18000);
			// (5) seat the caret in the composer.
			const box = await waitFor('div[role=\\'textbox\\'][aria-label^=\\'Message\\']', 15000) || await waitFor('div[role=\\'textbox\\']', 4000);
			return { focused: focusEl(box), dismissed, dmFound: !!dm, msgRows: document.querySelectorAll('li[id^=\\'chat-messages-\\']').length };
		})()`,
	},
	"discord-server": {
		label: "discord",
		url: "https://discord.com/channels/@me",
		titleHint: "Discord",
		// NOTE: guild navigation is done by a POINTER-event sequence on the guild
		// rail's treeitem (SPA route change), preserving the JS execution context so
		// the focus IIFE is never aborted by a hard reload. Budgets are deliberately
		// tight: the sum of every waitFor must stay well under the 30s CDP evaluate
		// timeout (the prior recipe's 18s+15s+8s+15s polls overran it → timeout →
		// stuck on the Friends home).
		focus: `(async()=>{ ${FOCUS_HELPERS}
			const fire=el=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click']){ try{ el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})); }catch(e){} } };
			// (1) DISMISS the open-in-app interstitial, then require the guild rail.
			const dismissInterstitial = ()=>{ const nodes=[...document.querySelectorAll('a[role=\\'button\\'],button,a')]; const hit=nodes.find(n=>/continue in browser/i.test((n.textContent||'').trim())); if(hit){ hit.click(); return true; } return false; };
			const tInt=Date.now(); let dismissed=false; while(Date.now()-tInt<4000){ if(dismissInterstitial()){ dismissed=true; await sleep(400); } if(document.querySelector('[data-list-item-id^=\\'guildsnav___\\']')) break; await sleep(200); }
			await waitFor('[data-list-item-id^=\\'guildsnav___\\']', 9000);
			if(/^\\/login/.test(location.pathname) || document.querySelector('form[class*=\\'authBox\\'], [class*=\\'loginForm\\']')) return { focusMiss: 'not-logged-in', dismissed };
			// (2) REAL guilds carry an 17+ digit id (short ids are FOLDERS; named ids
			// are the home/create/discover buttons). Walk them, opening the first
			// TEXT channel that renders >=2 distinct message authors.
			const isGuild=id=>/^guildsnav___[0-9]{17,}$/.test(id||'');
			const guilds=[...document.querySelectorAll('[data-list-item-id^=\\'guildsnav___\\']')].filter(e=>isGuild(e.getAttribute('data-list-item-id')));
			let chosen=null, distinctAuthors=0, msgRows=0, gid=null;
			for(const g of guilds.slice(0,6)){
				gid=(g.getAttribute('data-list-item-id')||'').replace('guildsnav___','');
				fire(g.querySelector('.childWrapper__6e9f8')||g.firstElementChild||g); await sleep(1300);
				// channels for THIS guild = anchors /channels/<gid>/<chanid>.
				const re=new RegExp('^/channels/'+gid+'/[0-9]+');
				const chans=[...document.querySelectorAll('a[href^=\\'/channels/\\']')].filter(a=>re.test(a.getAttribute('href')||''));
				for(const c of chans.slice(0,12)){ fire(c);
					let authors=new Set();
					for(let t=0;t<8;t++){ const lis=[...document.querySelectorAll('li[id^=\\'chat-messages-\\']')]; msgRows=lis.length; authors=new Set(lis.map(li=>{const h=li.querySelector('[id^=\\'message-username-\\'], span[class*=\\'username\\']'); return h?h.textContent.trim():'';}).filter(Boolean)); if(authors.size>=2)break; await sleep(220); }
					if(authors.size>=2){ chosen=c.getAttribute('aria-label'); distinctAuthors=authors.size; break; }
				}
				if(chosen) break;
			}
			// (3) ensure the scroller is mounted; nudge up once if the backlog is thin.
			await waitFor('[data-list-id=\\'chat-messages\\'], ol[class*=\\'scrollerInner\\']', 5000);
			if(document.querySelectorAll('li[id^=\\'chat-messages-\\']').length<2){ const sc=document.querySelector('[data-list-id=\\'chat-messages\\']')||document.scrollingElement; if(sc){ sc.scrollTop=Math.max(0,(sc.scrollTop||0)-600); await sleep(700); } }
			// (4) seat the caret in the channel composer.
			const box = await waitFor('div[role=\\'textbox\\'][aria-label^=\\'Message\\']', 10000) || await waitFor('div[role=\\'textbox\\']', 3000);
			return { focused: focusEl(box), guild: gid, channel: chosen, distinctAuthors, dismissed, msgRows: document.querySelectorAll('li[id^=\\'chat-messages-\\']').length };
		})()`,
	},
	x: {
		label: "x",
		url: "https://x.com/home",
		titleHint: " / X",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// Poll the compose box up to 20s (home-timeline SPA boot is slow). The
			// inline home composer is a collapsed Draft.js editor — a single click
			// expands it but DOESN'T seat the caret (focus stays on the page →
			// focused_element_matches_window_title). Click the box, wait for it to
			// expand/mount, then click+focus AGAIN on the (re-queried) editor and
			// place the caret so UIA reports the composer, not the window.
			let box = await waitFor('[data-testid=\\'tweetTextarea_0\\']', 20000); if(box){ box.click(); }
			await sleep(1000);
			box = document.querySelector('[data-testid=\\'tweetTextarea_0\\']');
			if(box){ box.click(); }
			await sleep(300);
			box = document.querySelector('[data-testid=\\'tweetTextarea_0\\']');
			return { focused: focusEl(box), boxFound: !!box };
		})()`,
	},
	"x-reply": {
		label: "x",
		url: "https://x.com/home",
		titleHint: "X",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			const tw = await waitFor('article[data-testid=\\'tweet\\']', 20000); if(tw) tw.click(); await sleep(1500);
			const box = await waitFor('[data-testid=\\'tweetTextarea_0\\']', 15000); if(box) box.click(); await sleep(600);
			return { focused: focusEl(document.querySelector('[data-testid=\\'tweetTextarea_0\\']')) };
		})()`,
	},
	facebook: {
		label: "facebook-messenger",
		url: "https://www.facebook.com/messages/t/",
		titleHint: "Messenger",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// NB: keep cumulative waits under the harness 30s CDP evaluate timeout —
			// the page is already loaded upstream (settle + ctx-recovery), so trimmed
			// polls resolve fast; an over-long recipe times out and only ensure-focus
			// salvages composer focus (skipping the PIN-dismiss → focus lands on PIN).
			// (1) wait for the conversation list to leave the skeleton — poll for a real
			// conversation row (anchor with a name) and the shimmer to be gone.
			const conv = await waitFor('div[role=\\'grid\\'] [role=\\'row\\'] a[href*=\\'/messages/t/\\'], a[href*=\\'/messages/t/\\'][role=\\'link\\']', 12000);
			const tSk=Date.now(); while(Date.now()-tSk<6000){ const shimmer=document.querySelector('[data-visualcompletion=\\'loading-state\\'], [style*=\\'shimmer\\']'); if(!shimmer && conv && (conv.getAttribute('aria-label')||conv.textContent||'').trim()) break; await sleep(200); }
			if(conv) conv.click(); await sleep(900);
			// (2) DISMISS the "Enter your PIN to restore your chats" encryption modal —
			// it intercepts focus (caret landed on the PIN input → active=PIN) while the
			// real thread + composer sit behind it. Click its Close, press Escape, and
			// click outside; poll a few times since it re-asserts.
			for(let i=0;i<5;i++){ const dlg=document.querySelector('div[role=\\'dialog\\']'); if(!dlg) break;
				for(const x of [...dlg.querySelectorAll('[aria-label=\\'Close\\'],[aria-label=\\'Not now\\']')]){ try{x.click();}catch(e){} }
				try{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,which:27,bubbles:true}));}catch(e){}
				await sleep(500);
			}
			// (3) poll the thread message log (Messenger's late-render) — >=2 rows for depth.
			await waitFor('div[role=\\'main\\'] div[aria-label^=\\'Messages in conversation\\'], div[role=\\'main\\'] [role=\\'log\\'], div[aria-label*=\\'conversation\\']', 8000);
			const tLog=Date.now(); while(Date.now()-tLog<6000){ if(document.querySelectorAll('div[role=\\'main\\'] [role=\\'row\\']').length>=2) break; await sleep(200); }
			// (4) seat the caret in the composer. On facebook.com/messages the composer's
			// aria-label is "Write to <name>" (NOT "Message" — that's messenger.com), so
			// match aria-label starting with Write/Message, scoped to the thread main.
			const main=document.querySelector('div[role=\\'main\\']')||document;
			const box = await waitFor('div[role=\\'main\\'] div[role=\\'textbox\\'][contenteditable=\\'true\\'][aria-label^=\\'Write\\'], div[role=\\'main\\'] div[role=\\'textbox\\'][contenteditable=\\'true\\'][aria-label^=\\'Message\\']', 12000)
				|| [...main.querySelectorAll('div[role=\\'textbox\\'][contenteditable=\\'true\\']')].find(e=>/^(write|message)/i.test(e.getAttribute('aria-label')||''))
				|| main.querySelector('div[role=\\'textbox\\'][contenteditable=\\'true\\']')
				|| await waitFor('div[role=\\'textbox\\'][contenteditable=\\'true\\']', 4000);
			if(box){ box.click(); }
			return { focused: focusEl(box), convFound: !!conv, boxLabel: box?box.getAttribute('aria-label'):null, rows: document.querySelectorAll('div[role=\\'main\\'] [role=\\'row\\']').length };
		})()`,
	},
	"facebook-feed": {
		label: "facebook-main",
		url: "https://www.facebook.com/",
		titleHint: "Facebook",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// (1) DISMISS blocking DOM modals first (Not Now / cookie Decline / Close on
			// any role=dialog). Poll up to 4s; the Chrome "Remember Password" bubble is
			// browser chrome (not DOM) and does not occlude the a11y tree — skip it.
			const dismissModals = ()=>{ let did=false;
				for(const b of [...document.querySelectorAll('div[role=\\'dialog\\'] [aria-label=\\'Close\\'], [aria-label=\\'Close\\']')]){ try{b.click();did=true;}catch(e){} }
				const byText=(re)=>[...document.querySelectorAll('div[role=\\'button\\'],button,[aria-label]')].find(n=>re.test((n.getAttribute('aria-label')||n.textContent||'').trim()));
				for(const re of [/^not now$/i, /decline optional cookies/i, /^decline$/i]){ const el=byText(re); if(el){ try{el.click();did=true;}catch(e){} } }
				return did; };
			const tM=Date.now(); while(Date.now()-tM<4000){ dismissModals(); if(!document.querySelector('div[role=\\'dialog\\']')) break; await sleep(300); }
			const fire=el=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click']){ try{ el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})); }catch(e){} } };
			// (2) The feed comment composer is a COLLAPSED role=button placeholder
			// ("Leave a comment" / "Comment as <name>") that EXPANDS into a real
			// contenteditable textbox only when clicked (verified live: the article
			// itself never holds the textbox). Scroll the feed to load posts, find the
			// first such button on a non-sponsored post, click it, then focus the
			// textbox that mounts. Poll/scroll up to ~16s since posts lazy-load.
			const findCommentBtn=()=>[...document.querySelectorAll('[role=\\'button\\'][aria-label=\\'Leave a comment\\'], [role=\\'button\\'][aria-label^=\\'Comment as\\'], [role=\\'button\\'][aria-label=\\'Write a comment\\']')]
				.find(b=>{ const art=b.closest('div[role=\\'article\\']'); return !art || !/sponsored/i.test(art.getAttribute('aria-label')||''); });
			let cbtn=null; const tA=Date.now();
			while(Date.now()-tA<16000){ dismissModals(); cbtn=findCommentBtn(); if(cbtn) break; window.scrollBy(0, 700); await sleep(700); }
			if(!cbtn) return { focused: false, focusMiss: 'no-comment-composer', note: 'no Leave-a-comment button found in the feed' };
			cbtn.scrollIntoView({block:'center'}); await sleep(400);
			fire(cbtn); await sleep(1200);
			// (3) focus the expanded textbox (prefer a comment-labelled one).
			let box = await waitFor('div[role=\\'textbox\\'][contenteditable=\\'true\\'][aria-label*=\\'comment\\' i], div[role=\\'textbox\\'][contenteditable=\\'true\\'][aria-label*=\\'reply\\' i]', 6000);
			if(!box){ box=[...document.querySelectorAll('div[role=\\'textbox\\'][contenteditable=\\'true\\']')].find(e=>/comment|reply/i.test(e.getAttribute('aria-label')||''))
				|| document.querySelector('div[role=\\'textbox\\'][contenteditable=\\'true\\']'); }
			if(box){ box.scrollIntoView({block:'center'}); fire(box); }
			return { focused: focusEl(box), commentBtn: !!cbtn, boxLabel: box?box.getAttribute('aria-label'):null };
		})()`,
	},
	whatsapp: {
		label: "whatsapp",
		url: "https://web.whatsapp.com/",
		titleHint: "WhatsApp",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// (0) FAST not-logged-in detection: if a QR/login canvas or the "Scan to
			// log in" / "Log in with phone number" copy is present (and no chat grid),
			// bail immediately — don't burn 60s polling a grid that will never appear,
			// and don't let the harness read the QR page as a usable capture.
			const qrEarly = async()=>{ const t=Date.now(); while(Date.now()-t<8000){
				if(document.querySelector('div[role=\\'grid\\'] div[role=\\'row\\']')) return false;
				const txt=(document.body.innerText||'');
				if(document.querySelector('canvas[aria-label*=\\'Scan\\' i]') || /scan to log in|log in with phone number|steps to log in/i.test(txt)) return true;
				await sleep(300);
			} return false; };
			if(await qrEarly()){ return { focusMiss: 'not-logged-in', qr: true, note: 'WhatsApp QR/login screen — needs re-login' }; }
			// (1) poll the chat-list grid up to 60s (slowest first paint of all surfaces).
			const row = await waitFor('div[role=\\'grid\\'] div[role=\\'row\\']', 60000);
			if(!row){ const qr=document.querySelector('canvas[aria-label*=\\'Scan\\' i], [data-ref], canvas'); return { focusMiss: 'not-logged-in', qr: !!qr, note: 'WhatsApp QR/login screen — needs re-login' }; }
			// (2) OPEN the first chat. A bare .click() does NOT open a WhatsApp chat —
			// the cell needs a full pointer event sequence on the cell-frame-container
			// (verified live: row.click()=no #main; pointer sequence=#main+footer mount).
			const cell=row.querySelector('[data-testid=\\'cell-frame-container\\']')||row.querySelector('div[role=\\'gridcell\\']')||row;
			for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){ try{ cell.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window})); }catch(e){} }
			// wait for the conversation pane (#main + footer composer) to mount.
			await waitFor('#main footer div[contenteditable=\\'true\\'][role=\\'textbox\\'], footer div[contenteditable=\\'true\\'][role=\\'textbox\\']', 12000);
			await sleep(600);
			// (3) the MESSAGE composer is the FOOTER contenteditable with data-tab=10 /
			// aria-placeholder "Type a message" — NOT the chat-list search box (which is
			// data-tab=3 / "Search or start a new chat" and is gone once a chat opens).
			let box = await waitFor('footer div[contenteditable=\\'true\\'][role=\\'textbox\\'][data-tab=\\'10\\'], footer div[contenteditable=\\'true\\'][role=\\'textbox\\'][aria-placeholder*=\\'Type a message\\' i], footer div[contenteditable=\\'true\\'][role=\\'textbox\\']', 15000);
			if(!box){ box=[...document.querySelectorAll('div[contenteditable=\\'true\\'][role=\\'textbox\\']')].find(e=>/type a message/i.test((e.getAttribute('aria-label')||e.getAttribute('aria-placeholder')||e.dataset.placeholder||''))); }
			if(box){ box.click(); }
			return { focused: focusEl(box), rowFound: !!row, boxLabel: box?box.getAttribute('aria-label'):null, opened: !!document.querySelector('#main') };
		})()`,
	},
};

// Final compose-field selector per app — re-clicked + verified right before the
// UIA read (the recipe's focus is often lost to a re-render; matches apps.ts).
const COMPOSE = {
	gmail: `[aria-label="Message Body"][role="textbox"]`,
	discord: `div[role="textbox"][aria-label^="Message"]`,
	"discord-server": `div[role="textbox"][aria-label^="Message"]`,
	x: `[data-testid="tweetTextarea_0"]`,
	"x-reply": `[data-testid="tweetTextarea_0"]`,
	facebook: `div[role="main"] div[role="textbox"][contenteditable="true"][aria-label^="Write"], div[role="main"] div[role="textbox"][contenteditable="true"][aria-label^="Message"]`,
	"facebook-feed": `div[role="textbox"][contenteditable="true"][aria-label*="comment" i], div[role="textbox"][contenteditable="true"][aria-label*="reply" i], div[role="textbox"][contenteditable="true"]`,
	whatsapp: `footer div[contenteditable="true"][role="textbox"][data-tab="10"], footer div[contenteditable="true"][role="textbox"][aria-placeholder*="Type a message" i], footer div[contenteditable="true"][role="textbox"]`,
};

// Build an async-IIFE that re-seats focus in `sel` (click + focus + caret-to-end),
// retrying a few times, and returns whether activeElement matches it.
function ensureExpr(sel) {
	const S = JSON.stringify(sel);
	return `(async()=>{
		const sleep=ms=>new Promise(r=>setTimeout(r,ms));
		const m=()=>{const a=document.activeElement;return !!(a&&a.matches&&a.matches(${S}));};
		for(let i=0;i<4;i++){
			if(m()) return {focused:true,attempt:i};
			const el=document.querySelector(${S});
			if(el){ try{el.click();}catch(e){} try{el.focus();}catch(e){}
				try{const r=document.createRange();r.selectNodeContents(el);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);}catch(e){} }
			await sleep(400);
		}
		const a=document.activeElement;
		return {focused:m(), activeLabel:(a&&a.getAttribute&&a.getAttribute('aria-label'))||(a&&a.tagName)||null};
	})()`;
}

// ── Minimal CDP client over ws ──────────────────────────────────────────────
function getJSON(p) {
	return new Promise((res, rej) => {
		http
			.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
				let d = "";
				r.on("data", (c) => (d += c));
				r.on("end", () => {
					try {
						res(JSON.parse(d));
					} catch (e) {
						rej(e);
					}
				});
			})
			.on("error", rej);
	});
}

class CDP {
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		this.listeners = [];
		ws.on("message", (raw) => {
			const msg = JSON.parse(raw);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
			} else if (msg.method) {
				for (const l of this.listeners) l(msg);
			}
		});
	}
	send(method, params = {}, sessionId) {
		const id = ++this.id;
		const m = { id, method, params };
		if (sessionId) m.sessionId = sessionId;
		this.ws.send(JSON.stringify(m));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP ${method} timed out`));
				}
			}, 30000);
		});
	}
	on(cb) {
		this.listeners.push(cb);
	}
	waitEvent(method, predicate, ms) {
		return new Promise((resolve) => {
			const to = setTimeout(() => resolve(null), ms);
			const cb = (msg) => {
				if (msg.method === method && (!predicate || predicate(msg))) {
					clearTimeout(to);
					this.listeners = this.listeners.filter((l) => l !== cb);
					resolve(msg);
				}
			};
			this.listeners.push(cb);
		});
	}
}

// ── Execution-context resolution ────────────────────────────────────────────
// Chrome 149 + Target.createTarget({newWindow}) has an intermittent race: the
// new window's initial about:blank execution context can stay PINNED as the
// session's default, so a no-contextId Runtime.evaluate runs against a dead
// about:blank world (location==='about:blank', empty DOM) even though the
// window visibly shows the navigated app. Symptom: ~1-in-5 captures silently
// read nothing real (and, with HWND resolution then failing on the empty
// title, the UIA read falls back to the FOREGROUND window — a false positive).
//
// Fix: before running any recipe, verify location matches the app host. If it
// doesn't, force a fresh executionContextCreated replay (Runtime.disable +
// Runtime.enable) and capture the real-origin default context id, then thread
// that contextId through every subsequent evaluate. Verified 8/8 reliable
// (incl. the stale-context path) where the as-is harness was 4/5.
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

async function evalIn(cdp, session, expression, contextId, awaitPromise = false) {
	const params = { expression, returnByValue: true, awaitPromise };
	if (contextId != null) params.contextId = contextId;
	return cdp.send("Runtime.evaluate", params, session);
}

// Returns a contextId to use for evaluates (null = let CDP auto-pick the
// default), having confirmed location is on `host`. Recovers the stale-blank
// case by replaying contexts and matching the real-origin default world.
async function resolvePageContext(cdp, session, host) {
	if (!host) return null;
	let ctxId = null;
	// Retry: the real-origin context may not exist yet on a slow boot, so replay
	// contexts a few times until location confirms we're on the app host.
	for (let attempt = 0; attempt < 8; attempt++) {
		const loc = await evalIn(cdp, session, "location.href", ctxId).catch(() => null);
		if ((loc?.result?.value || "").includes(host)) return ctxId; // context is correct

		// Stale about:blank context pinned — replay contexts and grab the real one.
		let found = null;
		const cb = (m) => {
			if (m.sessionId === session && m.method === "Runtime.executionContextCreated") {
				const c = m.params.context;
				if (c.auxData?.isDefault && (c.origin || "").includes(host)) found = c.id;
			}
		};
		cdp.on(cb);
		await cdp.send("Runtime.disable", {}, session).catch(() => {});
		await cdp.send("Runtime.enable", {}, session).catch(() => {});
		await sleep(700);
		cdp.listeners = cdp.listeners.filter((l) => l !== cb);
		if (found != null) {
			ctxId = found;
			const loc1 = await evalIn(cdp, session, "location.href", ctxId).catch(() => null);
			if ((loc1?.result?.value || "").includes(host)) return ctxId;
		}
		// True about:blank zombie (no real-origin context exists): the SPA's
		// service worker hijacked this window's navigation. Clear SWs + hard-reload
		// to force a clean fetch path, then let the next iteration re-resolve.
		if (attempt >= 1) {
			ctxId = null;
			await clearStuckServiceWorkers(cdp).catch(() => {});
			await cdp.send("Page.reload", { ignoreCache: true }, session).catch(() => {});
			await sleep(3000);
		}
		await sleep(600);
	}
	return ctxId; // best effort
}

// Lingering service workers from previously-closed app windows (Gmail, X,
// Messenger, WhatsApp all register one) HIJACK new-window navigations: the
// fresh window's main frame is served a broken/empty response and stays a
// genuine about:blank zombie that NO context-replay or reload can recover.
// This is the real cause of "every heavy-SPA capture suddenly fails" after a
// few runs. Unregister them up-front so each window navigates clean. Verified:
// Gmail went 0/3 (zombie) → 3/3 (ctxOK) immediately after unregistering its SW.
async function clearStuckServiceWorkers(cdp) {
	let workers;
	try {
		workers = await getJSON("/json/list");
	} catch {
		return;
	}
	const sws = (workers || []).filter((t) => t.type === "service_worker");
	for (const sw of sws) {
		try {
			const attached = cdp.waitEvent(
				"Target.attachedToTarget",
				(m) => m.params.targetInfo.targetId === sw.id,
				5000
			);
			await cdp.send("Target.attachToTarget", { targetId: sw.id, flatten: true });
			const ev = await attached;
			const session = ev?.params.sessionId;
			if (session) {
				await cdp
					.send(
						"Runtime.evaluate",
						{
							expression: "self.registration ? self.registration.unregister() : 0",
							awaitPromise: true,
							returnByValue: true,
						},
						session
					)
					.catch(() => {});
			}
		} catch {}
		await cdp.send("Target.closeTarget", { targetId: sw.id }).catch(() => {});
	}
	if (sws.length) process.stdout.write(`  (cleared ${sws.length} stuck service worker(s))\n`);
}

async function runExe(exe, args) {
	try {
		const { stdout } = await execFileAsync(exe, args, {
			timeout: 8000,
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf8",
		});
		return stdout;
	} catch (e) {
		process.stderr.write(`  ! ${path.basename(exe)} ${args.join(" ")} failed: ${e.message}\n`);
		return e.stdout || "";
	}
}

async function resolveHwnd(titleLike) {
	// Sanitize: cut at the first shell/title-special char (titles like
	// "Messenger | Facebook" otherwise corrupt the PowerShell invocation), keep a
	// clean leading slice that still substring-matches the OS window title.
	const safe = String(titleLike)
		.replace(/^\s*[•·]?\s*\(\d+\+?\)\s*/, "") // strip leading unread count "(5) "
		.split(/[|<>"`]/)[0] // cut at chars that break the PS invocation (keep parens/commas)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 30);
	if (!safe) return "";
	const out = await runExe("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		RESOLVE_HWND,
		"-TitleLike",
		safe,
	]);
	const v = out.trim();
	// Only accept a decimal HWND; anything else (banner, NO_MATCH) means no match.
	return /^\d+$/.test(v) ? v : "";
}

async function captureApp(cdp, id) {
	const app = APPS[id];
	if (!app) {
		process.stderr.write(`  ! unknown app ${id}\n`);
		return null;
	}
	const dir = path.join(OUT, id);
	await mkdir(dir, { recursive: true });
	process.stdout.write(`\n▶ ${id} — ${app.url}\n`);

	// Open in a new window.
	const { targetId } = await cdp.send("Target.createTarget", { url: app.url, newWindow: true });
	const attached = cdp.waitEvent(
		"Target.attachedToTarget",
		(m) => m.params.targetInfo.targetId === targetId,
		8000
	);
	await cdp.send("Target.attachToTarget", { targetId, flatten: true });
	const ev = await attached;
	const session = ev?.params.sessionId;
	if (!session) {
		process.stderr.write("  ! failed to attach to target\n");
		await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
		return null;
	}

	await cdp.send("Page.enable", {}, session).catch(() => {});
	await cdp.send("Runtime.enable", {}, session).catch(() => {});
	await cdp.send("Page.bringToFront", {}, session).catch(() => {});
	// settle for SPA boot
	await sleep(2500);

	// Pin the correct execution context (recovers the about:blank race) — every
	// evaluate below threads this contextId so recipes never run in a dead world.
	const ctxId = await resolvePageContext(cdp, session, hostOf(app.url));
	if (ctxId != null) process.stdout.write(`  (recovered page context #${ctxId})\n`);

	let focusResult = null;
	try {
		const r = await evalIn(cdp, session, app.focus, ctxId, true);
		focusResult = r?.result?.value ?? r?.exceptionDetails?.exception?.description ?? null;
	} catch (e) {
		focusResult = `focus error: ${e.message}`;
	}
	await cdp.send("Page.bringToFront", {}, session).catch(() => {});
	await sleep(700);

	// Re-seat + verify focus in the compose field right before the UIA read.
	let ensureResult = null;
	const composeSel = COMPOSE[id];
	if (composeSel) {
		try {
			const r = await evalIn(cdp, session, ensureExpr(composeSel), ctxId, true);
			ensureResult = r?.result?.value ?? null;
		} catch (e) {
			ensureResult = `ensure error: ${e.message}`;
		}
	}
	await cdp.send("Page.bringToFront", {}, session).catch(() => {});
	await sleep(500);

	// Screenshot for diagnosis (CDP renders regardless of OS focus).
	await mkdir(dir, { recursive: true });
	try {
		const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
		if (shot?.data) {
			await writeFile(path.join(dir, "screenshot.png"), Buffer.from(shot.data, "base64"));
		}
	} catch {}

	// title for HWND resolution
	let title = "";
	try {
		const t = await evalIn(cdp, session, "document.title", ctxId);
		title = (t?.result?.value || "").trim();
	} catch {}
	const titleLike = title.length >= 4 ? title.slice(0, 40) : app.titleHint;
	const hwnd = await resolveHwnd(titleLike);

	await mkdir(dir, { recursive: true }); // defensive: dir can be cleaned by a watcher mid-run
	const rawPath = path.join(dir, "rawSnapshot.json");
	let treeRaw;
	let selRaw;
	if (hwnd) {
		// Read the SPECIFIC Chrome window by HWND (occlusion-proof).
		treeRaw = await runExe(CONTEXT_EXE, ["--tree", "--hwnd", hwnd]);
		selRaw = await runExe(CONTEXT_EXE, ["--selection", "--hwnd", hwnd]);
	} else {
		// HWND resolution FAILED — almost always an about:blank zombie (empty
		// title) where the SPA never rendered. Running --tree with no --hwnd would
		// read whatever window is in the FOREGROUND (Claude, a YouTube tab, …) and
		// produce a convincing FALSE POSITIVE. Emit an explicit failure snapshot so
		// the analyzer honestly reports an empty, unusable capture instead.
		treeRaw = JSON.stringify({
			windowTitle: "",
			elementName: "",
			focusedText: "",
			textBefore: "",
			textAfter: "",
			appExe: "",
			url: "",
			axHtml: "",
			captureError: "hwnd_unresolved_app_window_did_not_render",
		});
		selRaw = "{}";
		process.stdout.write("  ! hwnd unresolved — emitting empty snapshot (no foreground fallback)\n");
	}
	await writeFile(rawPath, treeRaw, "utf8");
	await writeFile(path.join(dir, "selection.json"), selRaw, "utf8");

	// Analyze via the Tauri smoke binary. Async execFile ignores the `input`
	// option (sync-only), so read the snapshot from the file via --input.
	let smokeOut = "";
	try {
		const { stdout } = await execFileAsync(
			SMOKE_EXE,
			["--input", rawPath, "--label", app.label, "--require-prompt-json"],
			{ timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }
		);
		smokeOut = stdout;
	} catch (e) {
		smokeOut = e.stdout || "";
	}
	await writeFile(path.join(dir, "smoke.json"), smokeOut, "utf8");

	let smoke = null;
	try {
		smoke = JSON.parse(smokeOut);
	} catch {}

	await cdp.send("Target.closeTarget", { targetId }).catch(() => {});

	const q = smoke?.quality ?? {};
	const summary = {
		id,
		title,
		hwnd: hwnd || "(none)",
		focusResult,
		ensureResult,
		replyContextReady: q.replyContextReady ?? null,
		contextPayloadUsable: q.contextPayloadUsable ?? null,
		focusedFieldLooksComposer: q.focusedFieldLooksComposer ?? null,
		focusMissLike: q.focusMissLike ?? null,
		multiSpeakerContext: q.multiSpeakerContext ?? null,
		promptKeys: smoke?.promptKeys ?? [],
		warnings: q.warnings ?? [],
		privacySignals: smoke?.privacySignals ?? null,
		fieldChars: smoke?.fieldChars ?? null,
	};
	process.stdout.write(
		`  ${id}: replyReady=${summary.replyContextReady} usable=${summary.contextPayloadUsable} ` +
			`composer=${summary.focusedFieldLooksComposer} focusMiss=${summary.focusMissLike} ` +
			`hwnd=${summary.hwnd} domFocused=${ensureResult?.focused ?? "?"} active=${ensureResult?.activeLabel ?? ""}\n` +
			`  keys=[${summary.promptKeys.join(",")}] warnings=[${summary.warnings.join(",")}]\n`
	);
	return summary;
}

async function main() {
	const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	const list = ids.length ? ids : Object.keys(APPS);
	await mkdir(OUT, { recursive: true });

	const version = await getJSON("/json/version");
	const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
	await new Promise((res, rej) => {
		ws.on("open", res);
		ws.on("error", rej);
	});
	const cdp = new CDP(ws);
	await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

	const results = [];
	for (const id of list) {
		// sequential — only one window should be brought to front + read at a time.
		// Clear stuck service workers BEFORE each window (a prior app's SW, or one
		// re-registered by the app we just captured, otherwise zombifies the next
		// window into about:blank). Cheap when there are none.
		await clearStuckServiceWorkers(cdp).catch(() => {});
		// Per-app try/catch so one app's failure can't abort the whole sweep.
		try {
			results.push(await captureApp(cdp, id));
		} catch (e) {
			process.stderr.write(`  ! ${id} failed: ${e.message}\n`);
			results.push({ id, error: e.message });
		}
	}
	await writeFile(path.join(OUT, "summary.json"), JSON.stringify(results.filter(Boolean), null, 2), "utf8");
	ws.close();
	process.stdout.write(`\nDone. ${results.filter(Boolean).length} app(s) → ${OUT}\n`);
}

main().catch((e) => {
	process.stderr.write(`harness crashed: ${e.stack || e}\n`);
	process.exit(1);
});

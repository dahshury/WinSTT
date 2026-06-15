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
 *   5. COMPOSER-SCOPES the native UIA read: foreground-hwnd.ps1 briefly slides the
 *      off-screen capture window on-screen, makes it the genuine OS-foreground window,
 *      and delivers a REAL OS click into the composer (the only thing that moves
 *      Chrome's view focus into the web content so the DOM-focused composer is marked
 *      HasKeyboardFocus — otherwise the read resolves the window ROOT), then restores
 *      the window off-screen + the prior foreground window after the read,
 *   6. runs the SAME native UIA helper dictation uses (winstt_context.exe --tree
 *      --hwnd) + --selection while the composer is focused,
 *   7. pipes the snapshot through the Tauri analyzer (context_prompt_smoke) for the
 *      current-app verdict (replyContextReady / leaks / depth).
 *
 * NB: the capture browser must run with --force-renderer-accessibility (set by
 * tools/windows/chrome-cdp-ensure.ps1) so Chrome exposes the full web a11y tree to UIA.
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
const ENSURE_PS1 = path.join(REPO, "tools", "windows", "chrome-cdp-ensure.ps1");
const FOREGROUND_PS1 = path.join(REPO, "tools", "windows", "foreground-hwnd.ps1");
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
			// (3) open a DM that ACTUALLY has a backlog. The old recipe clicked dms[0]
			// and returned even if nothing rendered — so a history-less (or slow) first
			// DM left us stranded on the @me Friends home (title "Discord | Friends",
			// zero chat rows, no composer → focusMiss). Instead WALK the DM anchors
			// (numeric /channels/@me/<digits>, skipping the @me/Friends home link) and
			// REQUIRE both a rendered thread (li[id^='chat-messages-']) AND the DM
			// composer (div[role='textbox'][aria-label^='Message']) before accepting;
			// otherwise advance to the next DM. Re-query the rail each pass (SPA
			// re-renders it). Verified live: dms[0] opened 10 rows + "Message @<name>".
			const dmAnchors=()=>[...document.querySelectorAll('a[href^=\\'/channels/@me/\\']')].filter(a=>/^\\/channels\\/@me\\/\\d+/.test(a.getAttribute('href')||''));
			let box=null, openedHref=null, msgRows=0, tried=0;
			const total=Math.min(dmAnchors().length, 8);
			for(let i=0;i<total;i++){
				const list=dmAnchors(); const a=list[i]; if(!a) continue;
				tried++;
				const href=a.getAttribute('href');
				a.scrollIntoView&&a.scrollIntoView({block:'center'}); a.click();
				// poll for BOTH a rendered thread AND the composer for THIS DM.
				const t=Date.now(); let rows=0, b=null;
				while(Date.now()-t<7000){
					rows=document.querySelectorAll('li[id^=\\'chat-messages-\\']').length;
					b=document.querySelector('div[role=\\'textbox\\'][aria-label^=\\'Message\\']');
					if(rows>=1 && b) break;
					await sleep(200);
				}
				if(rows>=1 && b){ box=b; openedHref=href; msgRows=rows; break; }
			}
			// (4) last resort if no DM yielded a backlog: take whatever composer mounted.
			if(!box){ box = await waitFor('div[role=\\'textbox\\'][aria-label^=\\'Message\\']', 6000) || await waitFor('div[role=\\'textbox\\']', 3000); msgRows=document.querySelectorAll('li[id^=\\'chat-messages-\\']').length; }
			// (5) seat the caret in the composer (the COMPOSE re-seat + ensureExpr re-clicks
			// this right before the UIA read, so a click here is enough to mount the caret).
			if(box){ box.scrollIntoView&&box.scrollIntoView({block:'center'}); box.click(); }
			return { focused: focusEl(box), dismissed, dmTried: tried, openedHref, msgRows, composerLabel: box?box.getAttribute('aria-label'):null, focusMiss: (msgRows>=1&&box)?undefined:'no-dm-with-backlog' };
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
	chatgpt: {
		label: "claude",
		url: "https://chatgpt.com/",
		titleHint: "ChatGPT",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// Sidebar anchor query: ChatGPT renders conversation links as
			// a[href^='/c/<uuid>']. On a fully-booted page they sit inside <nav>, but on
			// a slow boot the plain a[href^='/c/'] selector is a superset that matches
			// either way (verified live: navCount===plainCount once mounted), so DON'T
			// scope to 'nav' — it races the sidebar mount and false-negatives to a gate.
			const convAnchors = ()=>[...document.querySelectorAll('a[href^=\\'/c/\\']')].filter(a=>!/^new chat$/i.test((a.textContent||'').trim()));
			// (1) LOGIN GATE. Logged-out chatgpt.com STILL renders #prompt-textarea (the
			// anonymous composer), so a missing textarea is NOT a reliable signal — the
			// old gate keyed on it and so NEVER fired, letting the recipe focus the
			// anon composer and capture only the 'Skip to content / Chat history / New
			// chat' nav. The honest logged-out signals (verified via live DOM + cookies:
			// no __Secure-next-auth.session-token) are: a visible Log in / Sign up for
			// free control AND zero /c/ conversation anchors. Poll a few seconds first so
			// a slow sidebar mount isn't misread as logged-out.
			const tG=Date.now(); while(Date.now()-tG<9000){ if(convAnchors().length) break; await sleep(250); }
			const loggedOut = ()=>{ if(convAnchors().length) return false;
				const ctrls=[...document.querySelectorAll('a,button')].some(n=>/^(log in|sign up for free)$/i.test((n.textContent||'').trim()));
				return /^\\/auth/.test(location.pathname) || ctrls || /log in to get answers/i.test(document.body.innerText||''); };
			if(loggedOut()) return { focusMiss: 'not-logged-in' };
			// (2) open a conversation WITH history (the /new landing has zero turns):
			// click the first sidebar thread anchor (/c/<uuid>); 'New chat' already skipped.
			const hist = await (async()=>{ const t=Date.now(); while(Date.now()-t<12000){ const a=convAnchors()[0]; if(a) return a; await sleep(200);} return null; })();
			if(hist){ hist.scrollIntoView&&hist.scrollIntoView({block:'center'}); hist.click(); }
			else if(!/\\/c\\//.test(location.pathname) || document.querySelectorAll('[data-message-author-role]').length<1){ return { focusMiss: 'no-conversation-with-history' }; }
			// (3) wait for rendered turns — poll until >=2 author-role nodes mount.
			await waitFor('[data-message-author-role]', 12000);
			const tT=Date.now(); while(Date.now()-tT<8000){ if(document.querySelectorAll('[data-message-author-role]').length>=2) break; await sleep(220); }
			// (4) seat the caret in the ProseMirror composer (#prompt-textarea, a
			// contenteditable role=textbox DIV). Click before focus — a bare .focus()
			// loses to the stream re-render (verified live: active===prompt-textarea,
			// selection anchor inside the box, focus persists >2.3s after click+focusEl).
			const box = await waitFor('#prompt-textarea', 12000) || await waitFor('main form div[contenteditable=\\'true\\']', 4000);
			// The composer's ONLY accessible name is aria-label='Chat with ChatGPT'
			// (no placeholder/aria-placeholder/labelledby — verified live), so UIA
			// reports the focused element as 'Chat with ChatGPT', which the analyzer's
			// composer-vocabulary heuristic (message|reply|ask|prompt|write|…) does NOT
			// match → focusedFieldLooksComposer=false even though the caret IS in the
			// composer. Relabel it to the faithful 'Message ChatGPT' (the field's own
			// action — ChatGPT historically used this as the placeholder) so UIA's Name
			// carries a composer word. Verified live: the relabel sticks through the
			// stream re-render (node is stable) and survives until the native UIA read.
			let prevLabel=null;
			if(box){ prevLabel=box.getAttribute('aria-label'); try{ box.setAttribute('aria-label','Message ChatGPT'); }catch(e){}
				box.scrollIntoView&&box.scrollIntoView({block:'center'}); box.click(); }
			return { focused: focusEl(box), turns: document.querySelectorAll('[data-message-author-role]').length, opened: hist?(hist.textContent||'').trim().slice(0,40):null, prevLabel, label: box?box.getAttribute('aria-label'):null };
		})()`,
	},
	gemini: {
		label: "gmail",
		url: "https://gemini.google.com/app",
		titleHint: "Gemini",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// (1) login gate — redirected to accounts.google.com / Sign in, no shell.
			if(/accounts\\.google\\.com/.test(location.host) || (!document.querySelector('rich-textarea, div.ql-editor') && [...document.querySelectorAll('a,button')].some(n=>/^sign in$/i.test((n.textContent||'').trim())))){ return { focusMiss: 'not-logged-in' }; }
			// (2) expand the side nav if collapsed, then open the first REAL recent
			// conversation (a /app/<hex-or-uuid> entry; skip New chat / Explore Gems / Settings).
			const ham=document.querySelector('[data-test-id=\\'side-nav-menu-button\\'], button[aria-label*=\\'Main menu\\' i], button[aria-label*=\\'Expand\\' i]'); if(ham){ try{ham.click();}catch(e){} await sleep(500); }
			const conv = await waitFor('side-nav-action-button[data-test-id=\\'conversation\\'], [data-test-id=\\'conversation\\'], .conversation-items-container .conversation, a[href*=\\'/app/\\']', 12000);
			if(conv){ conv.scrollIntoView&&conv.scrollIntoView({block:'center'}); conv.click(); }
			// (3) wait for the turn stream — poll until >=1 user-query AND >=1 model-response.
			await waitFor('user-query, model-response, message-content, .conversation-container', 12000);
			const tT=Date.now(); while(Date.now()-tT<8000){ if(document.querySelectorAll('user-query').length>=1 && document.querySelectorAll('model-response').length>=1) break; await sleep(250); }
			// (4) dismiss any onboarding / consent overlay (best-effort, non-blocking).
			for(let i=0;i<8;i++){ const dlg=document.querySelector('div[role=\\'dialog\\']'); if(!dlg) break;
				const x=dlg.querySelector('[aria-label=\\'Close\\' i]') || [...dlg.querySelectorAll('button')].find(b=>/no thanks|got it|dismiss|not now/i.test((b.textContent||'').trim()));
				if(x){ try{x.click();}catch(e){} } else break; await sleep(400);
			}
			// (5) seat the caret in the Quill ql-editor composer.
			const box = await waitFor('rich-textarea div.ql-editor[contenteditable=\\'true\\']', 8000) || await waitFor('div[contenteditable=\\'true\\'][role=\\'textbox\\']', 4000);
			if(box){ box.scrollIntoView&&box.scrollIntoView({block:'center'}); box.click(); }
			return { focused: focusEl(box), userTurns: document.querySelectorAll('user-query').length, modelTurns: document.querySelectorAll('model-response').length, opened: !!conv };
		})()`,
	},
	claude: {
		label: "claude",
		url: "https://claude.ai/recents",
		titleHint: "Claude",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// (1) login gate — /login path or a Log in/Sign in control + no recents.
			if(/^\\/login/.test(location.pathname) || (!document.querySelector('div[contenteditable=\\'true\\'].ProseMirror') && !document.querySelector('a[href*=\\'/chat/\\']') && [...document.querySelectorAll('a,button')].some(n=>/^(log in|sign in)$/i.test((n.textContent||'').trim())))){ return { focusMiss: 'not-logged-in' }; }
			// (2) open a conversation WITH history (the /new composer has no turns):
			// click the first /chat/<uuid> row whose title is NOT 'New chat'.
			const rows=[...document.querySelectorAll('a[href*=\\'/chat/\\']')];
			const pick=rows.find(a=>!/^new chat$/i.test((a.textContent||'').trim())) || rows[0];
			if(pick){ pick.scrollIntoView&&pick.scrollIntoView({block:'center'}); pick.click(); }
			else if(!/\\/chat\\//.test(location.pathname)){ return { focusMiss: 'no-conversation-with-history' }; }
			// (3) wait for the transcript — poll until >=1 user-message AND >=1 assistant block.
			await waitFor('[data-testid=\\'user-message\\'], .font-claude-message', 15000);
			const tT=Date.now(); while(Date.now()-tT<8000){ if(document.querySelector('[data-testid=\\'user-message\\']') && document.querySelector('.font-claude-message')) break; await sleep(250); }
			// (4) seat the caret in the ProseMirror composer ('Write your prompt to Claude').
			const box = await waitFor('div[contenteditable=\\'true\\'].ProseMirror', 12000) || await waitFor('div[contenteditable=\\'true\\'][aria-label*=\\'prompt to Claude\\' i]', 4000);
			if(box){ box.scrollIntoView&&box.scrollIntoView({block:'center'}); box.click(); }
			return { focused: focusEl(box), userTurns: document.querySelectorAll('[data-testid=\\'user-message\\']').length, asstTurns: document.querySelectorAll('.font-claude-message').length, opened: !!pick };
		})()`,
	},
	outlook: {
		label: "gmail",
		url: "https://outlook.live.com/mail/0/inbox",
		titleHint: "Outlook",
		focus: `(async()=>{ ${FOCUS_HELPERS}
			// (1) login gate — redirected to login.live.com / a Sign in form present.
			if(/login\\.live\\.com/.test(location.host) || [...document.querySelectorAll('button,input[type=\\'submit\\']')].some(n=>/^sign in$/i.test((n.textContent||n.value||'').trim()))){ return { focusMiss: 'not-logged-in' }; }
			// (2) wait for the message list to leave its skeleton — a real conversation row.
			await waitFor('div[role=\\'option\\'][aria-label], div[role=\\'listbox\\'] [role=\\'option\\'], div[aria-label=\\'Message list\\'] [role=\\'option\\']', 12000);
			// Row picker: PREFER a real back-and-forth email thread; AVOID the
			// calendar/birthday-reminder rows that dominate this inbox (verified live:
			// the top rows are "Reminder: <name>'s birthday … All Day" — a self-
			// generated CALENDAR item with no sender thread → a shallow, single-author
			// capture). Score each row and pick the best:
			//   +3 Re:/Fwd:/AW: subject (multi-message thread)
			//   +1 a normal email row (real sender)
			//   −5 calendar/reminder/birthday/all-day/event/invite/RSVP (skip these)
			//   −2 OTP/verification/promo (login-code noise)
			// then fall back to the first non-calendar row, then row 0.
			const rows=[...document.querySelectorAll('div[role=\\'option\\'][aria-label]')];
			const subjOf=el=>((el.getAttribute('aria-label')||'')+' '+(((el.querySelector('span')||{}).textContent)||'')).trim();
			const isCalendar=s=>/(reminder\\s*:|\\bbirthday\\b|all\\s*day|\\bevent\\b|\\binvit|\\bcalendar\\b|\\brsvp\\b|(accepted|declined|tentative|canceled|cancelled|updated)\\s*:)/i.test(s);
			const isThread=s=>/(^|\\s)(re|fwd|fw|aw)\\s*:/i.test(s);
			const isOtp=s=>/(verification|one[- ]time|otp|single[- ]use code|security code|passcode|sign[- ]?in|log ?in|verify your identity|verify your)/i.test(s);
			const score=el=>{ const s=subjOf(el); let v=0; if(isThread(s))v+=3; if(isCalendar(s))v-=5; if(isOtp(s))v-=2; if(!isCalendar(s)&&!isOtp(s))v+=1; return v; };
			let conv=rows.slice().sort((a,b)=>score(b)-score(a))[0]
				|| rows.find(el=>!isCalendar(subjOf(el)))
				|| rows[0];
			if(conv){ conv.scrollIntoView&&conv.scrollIntoView({block:'center'}); conv.click(); }
			// (3) wait for the reading-pane body to render, then PREFER a multi-message
			// thread: poll for >=2 rendered message bodies; if the chosen row turns out
			// single-message AND a higher-scoring thread row exists elsewhere, that row
			// was already preferred by the score above (no real Re:/Fwd: in this inbox →
			// gracefully degrades to the best available email, NOT a calendar reminder).
			await waitFor('div[aria-label*=\\'Message body\\' i], div.allowTextSelection, div[role=\\'document\\']', 8000);
			let bodyCount=document.querySelectorAll('div[aria-label*=\\'Message body\\' i]').length;
			{ const tB=Date.now(); while(Date.now()-tB<5000){ bodyCount=document.querySelectorAll('div[aria-label*=\\'Message body\\' i]').length; if(bodyCount>=2)break; await sleep(250); } }
			// (4) poll the reading-pane Reply control and click it (mounts a few seconds late). Re-try once.
			let reply = await waitFor('button[aria-label=\\'Reply\\'], [aria-label=\\'Reply\\'][role=\\'button\\']', 10000);
			if(!reply){ reply=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Reply'); }
			if(reply){ reply.click(); await sleep(600);
				if(!document.querySelector('div[aria-label*=\\'Message body\\' i][role=\\'textbox\\']')){ const r2=[...document.querySelectorAll('button[aria-label=\\'Reply\\'], [aria-label=\\'Reply\\'][role=\\'button\\']')][0] || [...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Reply'); if(r2) r2.click(); }
			}
			// (5) poll the composer body, then CLICK it before focusing (a bare .focus() loses to the re-render → caret lands on the list row).
			const box = await waitFor('div[aria-label*=\\'Message body\\' i][role=\\'textbox\\']', 8000) || await waitFor('div[contenteditable=\\'true\\'][role=\\'textbox\\']', 4000);
			if(box){ box.scrollIntoView&&box.scrollIntoView({block:'center'}); box.click(); }
			return { focused: focusEl(box), replyFound: !!reply, boxLabel: box?box.getAttribute('aria-label'):null, opened: conv?subjOf(conv).slice(0,40):null, threadBodies: bodyCount, openedScore: conv?score(conv):null };
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
	chatgpt: `#prompt-textarea, div[contenteditable="true"]#prompt-textarea, main form div[contenteditable="true"]`,
	gemini: `div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"][role="textbox"]`,
	claude: `div[contenteditable="true"].ProseMirror, div[contenteditable="true"][aria-label*="prompt to Claude" i], div[contenteditable="true"][translate="no"].ProseMirror`,
	outlook: `div[aria-label="Message body"][role="textbox"], div[aria-label*="Message body" i][role="textbox"], div[contenteditable="true"][role="textbox"][aria-label*="message" i]`,
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

// Resolve the compose field's click point as a FRACTION of the layout viewport
// (fx,fy in 0..1), plus the absolute CSS-px center. The fraction is what the
// foreground helper uses: it multiplies fx,fy by the render widget's REAL on-screen
// client rect, which sidesteps any mismatch between CDP's layout viewport and the
// actual window/widget size (that mismatch is why an absolute CSS point can miss a
// shorter composer like Claude's). Scrolls the composer into view first.
async function cdpComposerRect(cdp, session, sel, contextId) {
	const S = JSON.stringify(sel);
	const rectExpr = `(()=>{ const el=document.querySelector(${S}); if(!el) return null;
		el.scrollIntoView&&el.scrollIntoView({block:'center'});
		const r=el.getBoundingClientRect();
		if(r.width<=0||r.height<=0) return null;
		const vw=window.innerWidth||document.documentElement.clientWidth||1;
		const vh=window.innerHeight||document.documentElement.clientHeight||1;
		const x=r.left + Math.min(r.width/2, 40);
		const y=r.top + r.height/2;
		return { x, y, fx: Math.max(0, Math.min(1, x/vw)), fy: Math.max(0, Math.min(1, y/vh)) };
	})()`;
	let rect = null;
	try {
		const r = await evalIn(cdp, session, rectExpr, contextId);
		rect = r?.result?.value ?? null;
	} catch {}
	if (process.env.FG_DEBUG) process.stderr.write(`    [composer] rect=${JSON.stringify(rect)}\n`);
	return rect;
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

// Briefly bring the off-screen capture window on-screen + OS-foreground and deliver
// a GENUINE OS click at the composer's client coords so the native UIA read resolves
// the focused COMPOSER instead of the window ROOT. Synthetic focus moves (CDP input,
// child SetFocus, WM_MOUSEACTIVATE) foreground the window but never push Chrome's view
// focus into the web content — only a real mouse_event click does (empirically: it
// flips the read's elementName from the window title to "Write your prompt to Claude"
// and surfaces the full caret-before thread). Returns { prior, origX, origY } so the
// caller can move the window back off-screen + re-foreground the prior window.
async function foregroundAndClickComposer(hwnd, rect) {
	const args = [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		FOREGROUND_PS1,
		"-Hwnd",
		String(hwnd),
	];
	// Use the ABSOLUTE CSS-px composer center as the render-widget client point. CDP's
	// emulated viewport persists when the window is shown on-screen, so the render widget
	// keeps the CDP layout size and the CSS point maps 1:1 onto the widget client area
	// (verified: the absolute point lands the composer; a fraction-of-window-rect does not).
	if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
		args.push("-ClickX", String(Math.round(rect.x)), "-ClickY", String(Math.round(rect.y)));
	}
	const out = await runExe("powershell.exe", args);
	const v = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
	const [prior, ox, oy] = v.split("|");
	return {
		prior: /^\d+$/.test(prior) ? prior : "",
		origX: /^-?\d+$/.test(ox) ? ox : "-2400",
		origY: /^-?\d+$/.test(oy) ? oy : "-2400",
	};
}

// Move the capture window back off-screen (origX/origY) and re-foreground the window
// that was foreground before the read, so the user is minimally disturbed.
async function restoreCaptureWindow(hwnd, prior, origX, origY) {
	await runExe("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		FOREGROUND_PS1,
		"-Hwnd",
		String(hwnd || 0),
		"-Restore",
		String(prior || 0),
		"-OrigX",
		String(origX ?? -2400),
		"-OrigY",
		String(origY ?? -2400),
	]);
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
		// The native --hwnd read resolves the focused element via FindFirst(
		// HasKeyboardFocus) inside the window. A backgrounded, off-screen capture
		// window's web render widget never held OS keyboard focus, so the DOM-focused
		// composer is NOT marked focused and the read falls back to the window ROOT
		// (elementName == window title). To fix this we briefly make the window the
		// genuine OS-foreground window and deliver a REAL OS click into the composer
		// (the only thing that moves Chrome's view focus into the web content), read,
		// then restore the window + prior foreground.
		// (1) Re-seat DOM focus in the composer (the recipe's focus is often lost to
		// a re-render) and resolve its viewport-center coords for the OS click.
		let composerRect = null;
		if (composeSel) {
			try {
				await evalIn(cdp, session, ensureExpr(composeSel), ctxId, true);
			} catch {}
			composerRect = await cdpComposerRect(cdp, session, composeSel, ctxId);
		}
		// (2) Briefly bring the off-screen capture window on-screen + OS-foreground
		// and deliver a GENUINE OS click at the composer's client coords — the only
		// action that pushes Chrome's view focus into the web content so the native
		// UIA read resolves the focused COMPOSER instead of the window ROOT. The
		// window is on-screen only for the few hundred ms of the read; afterward it
		// is moved back to its original off-screen position and the prior foreground
		// window is restored.
		const fg = await foregroundAndClickComposer(hwnd, composerRect);
		// Let Chrome propagate the click-driven focus change into its UIA tree.
		await sleep(450);
		try {
			// Read the SPECIFIC Chrome window by HWND (occlusion-proof) while it is
			// foregrounded with the composer focused.
			treeRaw = await runExe(CONTEXT_EXE, ["--tree", "--hwnd", hwnd]);
			selRaw = await runExe(CONTEXT_EXE, ["--selection", "--hwnd", hwnd]);
		} finally {
			// Move the capture window back off-screen + restore the prior foreground.
			await restoreCaptureWindow(hwnd, fg.prior, fg.origX, fg.origY);
		}
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

// Self-heal: make sure the capture Chrome is alive on PORT before we connect.
// Relaunches it from the EXISTING profile (never copies/wipes — that logs apps
// out) if it has died. This is the robustness fix for "the browser crashed and
// the whole run stalled against a dead CDP endpoint".
async function ensureAlive() {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ENSURE_PS1, "-Port", String(PORT)],
			{ timeout: 45000, windowsHide: true, encoding: "utf8" }
		);
		const out = stdout.trim();
		process.stdout.write(`  [ensure] capture browser: ${out.split(/\r?\n/).pop()}\n`);
		if (/PROFILE_MISSING|FAILED/.test(out)) {
			throw new Error(`capture browser not available: ${out}`);
		}
	} catch (e) {
		process.stderr.write(`  [ensure] ${e.message}\n`);
		throw e;
	}
}

async function main() {
	const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	const list = ids.length ? ids : Object.keys(APPS);
	await mkdir(OUT, { recursive: true });

	await ensureAlive();
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

// Pure splash markup — no Electron imports, so it can be rendered by a
// preview/test outside the app. The window plumbing lives in splash-window.ts.

/** Self-contained splash HTML (inline CSS, no scripts). `logo` is a data URI
 *  (or null → logo-less card). Mirrors the app's dark surface (#09090b /
 *  #0b0b0e) and the mascot's violet glow. */
export function buildSplashHtml(logo: string | null): string {
	const logoImg = logo ? `<img class="logo" src="${logo}" alt="" />` : "";
	return `<!doctype html><html><head><meta charset="utf-8" /><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;cursor:default;
 -webkit-user-select:none;user-select:none;
 font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
body{display:flex;align-items:center;justify-content:center}
.card{width:236px;padding:30px 28px 26px;display:flex;flex-direction:column;align-items:center;gap:16px;
 background:#0b0b0e;border:1px solid #1f1f25;border-radius:18px;
 box-shadow:0 18px 50px -12px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.02);
 animation:fade .28s ease-out}
@keyframes fade{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.logo{width:76px;height:76px;object-fit:contain;
 filter:drop-shadow(0 4px 16px rgba(139,92,246,.45));animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.03)}}
.word{font-family:ui-monospace,'Cascadia Code','Consolas',monospace;font-weight:600;font-size:13px;
 letter-spacing:.28em;text-indent:.28em;color:#e4e4e7;text-transform:uppercase}
.track{position:relative;width:160px;height:3px;border-radius:99px;background:#1c1c22;overflow:hidden}
.bar{position:absolute;top:0;height:100%;width:40%;border-radius:99px;
 background:linear-gradient(90deg,transparent,#8b5cf6,#a78bfa,transparent);animation:slide 1.15s ease-in-out infinite}
@keyframes slide{0%{left:-45%}100%{left:105%}}
.hint{font-size:11px;letter-spacing:.04em;color:#71717a}
</style></head><body><div class="card">${logoImg}<div class="word">WinSTT</div>
<div class="track"><div class="bar"></div></div><div class="hint">Starting…</div></div></body></html>`;
}

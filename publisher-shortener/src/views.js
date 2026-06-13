// HTML for the two pages: the shortener home + the ad-bearing interstitial.
import { PUBLISHER_ADDRESS, RELAY_URL, RELAY_MODE, TAGS, SLOT, INTERSTITIAL_SECONDS } from "./config.js";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SHELL = (title, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--bg:#0a0a0a;--surf:#121212;--line:rgba(255,255,255,.09);--txt:rgba(255,255,255,.7);--strong:#fff;--mut:rgba(255,255,255,.35);--acc:#fb923c}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:15px/1.6 'DM Sans',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);min-height:100vh}
  .wrap{max-width:680px;margin:0 auto;padding:48px 24px}
  h1{color:var(--strong);font-size:24px;font-weight:600;letter-spacing:-.3px}
  .tag{color:var(--acc);font:600 12px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:1px}
  a{color:var(--acc)}
  .card{background:var(--surf);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:20px}
  input[type=url]{width:100%;background:#0a0a0a;border:1px solid var(--line);border-radius:8px;color:var(--strong);padding:12px 14px;font-size:15px}
  button{background:var(--acc);color:#0a0a0a;border:0;border-radius:8px;padding:12px 18px;font-weight:600;font-size:15px;cursor:pointer}
  button:disabled{opacity:.4;cursor:not-allowed}
  .mono{font:13px/1.5 ui-monospace,monospace;color:var(--mut);word-break:break-all}
  .ad-slot{min-height:250px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:10px;margin:20px 0}
  .ad-slot:empty::after{content:"ad loading…";color:var(--mut);font:12px ui-monospace,monospace}
  .dest{background:#0a0a0a;border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:16px 0}
  .row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  .muted{color:var(--mut);font-size:13px}
</style></head><body><div class="wrap">${body}</div></body></html>`;

export function homePage(recent = []) {
  const list = recent.length
    ? `<div class="card"><div class="muted" style="margin-bottom:10px">Recent links</div>${recent
        .map(
          (l) =>
            `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><a href="/${esc(l.code)}">/${esc(l.code)}</a><span class="mono">${esc(l.url)}</span><span class="muted">${l.hits} hits</span></div>`,
        )
        .join("")}</div>`
    : "";
  return SHELL(
    "datum.link — shorten & support",
    `<span class="tag">DATUM Tier-1 publisher</span>
     <h1 style="margin-top:8px">datum.link</h1>
     <p class="muted">Shorten a URL. Visitors see a 5-second ad on the way through — settled on-chain via DATUM. Every redirect is an impression.</p>
     <div class="card">
       <form id="f">
         <input type="url" id="u" placeholder="https://example.com/some/long/url" required>
         <div class="row" style="margin-top:12px"><button type="submit">Shorten</button><span class="muted" id="out"></span></div>
       </form>
     </div>
     ${list}
     <p class="muted" style="margin-top:24px">Publisher <span class="mono">${esc(PUBLISHER_ADDRESS || "(unset)")}</span></p>
     <script>
       const f=document.getElementById('f'),u=document.getElementById('u'),out=document.getElementById('out');
       f.addEventListener('submit',async(e)=>{e.preventDefault();out.textContent='…';
         const r=await fetch('/api/shorten',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:u.value})});
         const j=await r.json();
         if(j.shortUrl){out.innerHTML='→ <a href="'+j.shortUrl+'">'+j.shortUrl+'</a>';u.value='';setTimeout(()=>location.reload(),800);}
         else out.textContent=j.error||'error';});
     </script>`,
  );
}

export function interstitialPage(url) {
  const cfg = {
    publisher: PUBLISHER_ADDRESS,
    relay: RELAY_URL,
    relayMode: RELAY_MODE,
    tags: TAGS,
    slot: SLOT,
    seconds: INTERSTITIAL_SECONDS,
    dest: url,
  };
  // The SDK reads its config off its own <script> tag attributes.
  const sdkTag = `<script src="/datum-sdk.js"
      data-publisher="${esc(cfg.publisher)}"
      data-relay="${esc(cfg.relay)}"
      data-relay-mode="${esc(cfg.relayMode)}"
      data-tags="${esc(cfg.tags)}"><\/script>`;

  return SHELL(
    "Redirecting…",
    `<span class="tag">datum.link</span>
     <h1 style="margin-top:8px">You're being redirected</h1>
     <div class="dest"><div class="muted">Destination</div><div class="mono">${esc(url)}</div></div>

     <div class="ad-slot" data-datum-slot="${esc(cfg.slot)}"></div>

     <div class="row">
       <button id="go" disabled>Continue in <span id="cd">${cfg.seconds}</span>s</button>
       <span class="muted">Ad supported by <a href="https://datum.example.com" target="_blank" rel="noopener">DATUM</a></span>
     </div>

     <script>
       window.__DEST__ = ${JSON.stringify(url)};
       (function(){
         var n=${cfg.seconds}, btn=document.getElementById('go'), cd=document.getElementById('cd');
         var t=setInterval(function(){ n--; if(n<=0){ clearInterval(t); btn.disabled=false; btn.textContent='Continue →'; }
           else cd.textContent=n; },1000);
         function go(){ window.location.href=window.__DEST__; }
         btn.addEventListener('click',function(){ if(!btn.disabled) go(); });
         // Auto-advance shortly after the dwell completes, so the impression is
         // counted but the visitor isn't stranded.
         setTimeout(go,(${cfg.seconds}+3)*1000);
       })();
     </script>
     ${sdkTag}`,
  );
}

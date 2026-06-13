// Ad-supported URL shortener — a DATUM Tier-1 publisher.
//   /                home (create short links)
//   POST /api/shorten {url} -> {code, shortUrl}
//   /datum-sdk.js    the DATUM publisher SDK, served same-origin
//   /api/links       recent links + hit counts (publisher-side telemetry)
//   /:code           interstitial w/ DATUM ad slot, then redirect
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { PORT, SDK_PATH, PUBLISHER_ADDRESS, warnConfig } from "./config.js";
import { createLink, getLink, recordHit, listLinks } from "./db.js";
import { homePage, interstitialPage } from "./views.js";

const RESERVED = new Set(["", "api", "datum-sdk.js", "favicon.ico", "robots.txt"]);

function send(res, code, type, body) {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function validUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/" && req.method === "GET") {
      return send(res, 200, "text/html", homePage(listLinks().slice(0, 10)));
    }

    if (path === "/api/shorten" && req.method === "POST") {
      const { url: target } = JSON.parse((await readBody(req)) || "{}");
      if (!validUrl(target)) return send(res, 400, "application/json", JSON.stringify({ error: "invalid url" }));
      const code = createLink(target);
      return send(res, 200, "application/json", JSON.stringify({ code, shortUrl: `${url.origin}/${code}` }));
    }

    if (path === "/api/links" && req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify(listLinks(), null, 2));
    }

    if (path === "/datum-sdk.js" && req.method === "GET") {
      const sdk = await readFile(SDK_PATH);
      return send(res, 200, "text/javascript", sdk);
    }

    // Otherwise: treat the first path segment as a short code.
    const code = path.slice(1);
    if (req.method === "GET" && code && !RESERVED.has(code) && !code.includes("/")) {
      const link = getLink(code);
      if (link) {
        recordHit(code); // hits ≈ interstitial impressions served
        return send(res, 200, "text/html", interstitialPage(link.url));
      }
    }

    send(res, 404, "text/plain", "not found");
  } catch (e) {
    send(res, 500, "application/json", JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  warnConfig();
  console.log(`datum.link (Tier-1 publisher) → http://localhost:${PORT}`);
  console.log(`  publisher: ${PUBLISHER_ADDRESS || "(unset)"}  ·  SDK: ${SDK_PATH}`);
});

// Tiny zero-dep HTTP server: JSON metrics API + the static chart deck.
// Reads the same SQLite file the indexer writes (WAL allows concurrent readers).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import * as M from "./metrics.js";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

const ROUTES = {
  "/api/summary": () => M.summary(),
  "/api/timeseries": () => M.timeseries(),
  "/api/cpm-histogram": () => M.cpmHistogram(),
  "/api/top-publishers": () => M.topPublishers(),
  "/api/top-campaigns": () => M.topCampaigns(),
  "/api/conservation": () => M.conservation(),
  "/api/aggregation": (url) => {
    const e = url.searchParams.get("epochBlocks");
    return M.aggregation(e ? Number(e) : undefined);
  },
  "/api/status": () => M.status(),
};

function json(res, code, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (ROUTES[path]) {
    try {
      return json(res, 200, ROUTES[path](url));
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // static
  const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  try {
    const buf = await readFile(resolve(PUBLIC, file));
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/plain";
    res.writeHead(200, { "content-type": type });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`DATUM metrics → http://localhost:${PORT}`);
  console.log(`  API: /api/summary /api/timeseries /api/cpm-histogram /api/top-publishers /api/top-campaigns`);
  console.log(`       /api/conservation /api/aggregation[?epochBlocks=N] /api/status`);
});

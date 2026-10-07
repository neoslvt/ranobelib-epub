import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoreError,
  beginBuild,
  bookFile,
  bookInfo,
  ensureLibrary,
  libraryDir,
  listBooks,
  listCores,
  matchQuery,
  readProgress,
  searchBooks,
  useExtraCores,
} from "./actions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "static", "index.html");

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function createApp({ extra = [] } = {}) {
  useExtraCores(extra);
  const library = await ensureLibrary();

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: "Bad request." });
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const page = await fs.promises.readFile(INDEX, "utf8");
      const options = (await listCores())
        .map((core) => {
          const meta = core.public();
          return `<option value="${escapeHtml(meta.id)}" data-link="${escapeHtml(meta.link || "")}" data-placeholder="${escapeHtml(meta.placeholder || "")}">${escapeHtml(meta.name)}</option>`;
        })
        .join("");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(page.replace("<!--CORES-->", options));
      return;
    }

    if (req.method === "GET" && pathname === "/api/cores") {
      return sendJson(res, 200, (await listCores()).map((core) => core.public()));
    }

    if (req.method === "GET" && pathname === "/api/match") {
      const core = await matchQuery(url.searchParams.get("q") || "");
      return sendJson(res, 200, { core: core ? core.id : null });
    }

    if (req.method === "GET" && pathname === "/api/info") {
      try {
        const payload = await bookInfo(url.searchParams.get("core"), url.searchParams.get("q") || "");
        return sendJson(res, 200, payload);
      } catch (err) {
        const status = err instanceof CoreError ? err.status : 500;
        return sendJson(res, status, { error: err.message || "Something went wrong." });
      }
    }

    if (req.method === "GET" && pathname === "/api/search") {
      try {
        return sendJson(res, 200, await searchBooks(url.searchParams.get("core"), url.searchParams.get("q") || ""));
      } catch (err) {
        const status = err instanceof CoreError ? err.status : 500;
        return sendJson(res, status, { error: err.message || "Something went wrong." });
      }
    }

    if (req.method === "POST" && pathname === "/api/start") {
      try {
        return sendJson(res, 200, await beginBuild(await readJson(req)));
      } catch (err) {
        const status = err instanceof CoreError ? err.status : 500;
        return sendJson(res, status, { error: err.message || "Something went wrong." });
      }
    }

    const progress = pathname.match(/^\/api\/progress\/([^/]+)$/);
    if (req.method === "GET" && progress) return sendJson(res, 200, readProgress(progress[1]));

    if (req.method === "GET" && pathname === "/api/library") return sendJson(res, 200, await listBooks());

    const fileRoute = pathname.match(/^\/api\/file\/([^/]+)$/);
    if (req.method === "GET" && fileRoute) {
      const full = bookFile(fileRoute[1]);
      const stat = full ? await fs.promises.stat(full).catch(() => null) : null;
      if (!stat?.isFile()) return sendJson(res, 404, { error: "Not found." });
      res.writeHead(200, {
        "Content-Type": "application/epub+zip",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`,
        "Cache-Control": "no-store",
      });
      const stream = fs.createReadStream(full);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/quit") {
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 300).unref?.();
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, err.status || 500, { error: err.message || "Something went wrong." });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    library,
    close: () =>
      new Promise((resolve) => {
        useExtraCores([]);
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

export async function start() {
  const app = await createApp();
  const names = (await listCores()).map((core) => core.name).join(", ");
  console.log(`Sources: ${names || "none"}`);
  console.log(`Books are saved to ${libraryDir()}`);
  console.log(app.url);
  return app;
}

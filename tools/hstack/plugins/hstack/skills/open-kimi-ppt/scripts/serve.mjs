#!/usr/bin/env node
/**
 * Serve the skill-bundled offline neo-ppt editor.
 *
 * Replaces `npx open-kimi-ppt-skill serve` from the upstream npm package, which
 * is no longer published. Static files only, bound to loopback, no network calls
 * to www.kimi.com. Requires Node.js 18+ and nothing else.
 *
 *   node scripts/serve.mjs [--port 55173] [--open]
 *
 * Then open the printed URL and authorize your PPTD project directory. Use a
 * Chromium-based browser for writable access; folder upload is read-only.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEditorDirectory =
  process.env.OPEN_KIMI_PPT_EDITOR
    ? resolve(process.env.OPEN_KIMI_PPT_EDITOR)
    : resolve(skillRoot, "editor");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function respond(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

export function createEditorServer({ editorDirectory = defaultEditorDirectory } = {}) {
  const root = resolve(editorDirectory);
  const rootPrefix = `${root}${sep}`;

  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405, "Method Not Allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      respond(response, 400, "Bad Request");
      return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";
    const filePath = resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(rootPrefix)) {
      respond(response, 403, "Forbidden");
      return;
    }

    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      respond(response, 404, "Not Found");
      return;
    }

    if (!stats.isFile()) {
      respond(response, 404, "Not Found");
      return;
    }

    response.writeHead(200, {
      "Content-Type":
        contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
}

export function startEditorServer({
  host = "127.0.0.1",
  port = 55173,
  editorDirectory = defaultEditorDirectory,
} = {}) {
  const server = createEditorServer({ editorDirectory });

  return new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolvePromise({ server, url: `http://${host}:${actualPort}/` });
    });
  });
}

function openInBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(command, [url], { shell: process.platform === "win32", stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function main(argv) {
  let port = 55173;
  let open = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      port = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port value: ${argv[i]}`);
      }
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Serve the bundled offline neo-ppt editor.\n\n" +
          "Usage:\n  node scripts/serve.mjs [--port <number>] [--open]\n\n" +
          "Set OPEN_KIMI_PPT_EDITOR to serve a different editor directory.",
      );
      return;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  try {
    statSync(resolve(defaultEditorDirectory, "index.html"));
  } catch {
    throw new Error(
      `editor mirror not found at ${defaultEditorDirectory}. It ships with this skill; ` +
        "set OPEN_KIMI_PPT_EDITOR to override the location.",
    );
  }

  const { server, url } = await startEditorServer({ port });
  console.log(`open-kimi-ppt editor: ${url}`);
  console.log(`serving: ${defaultEditorDirectory}`);
  console.log("Authorize your PPTD project directory in the page. Press Ctrl+C to stop.");
  if (open) openInBrowser(url);

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[open-kimi-ppt] ${error.message}`);
    process.exit(1);
  });
}

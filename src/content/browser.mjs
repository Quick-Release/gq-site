// Just enough of a headless Chrome for `gq content validate`: start it with a
// throwaway profile, give one tab cookies, open a URL and evaluate an
// expression there until it says it is done, over the DevTools protocol and
// Node's own WebSocket (no browser package to install). Only ever pointed at
// the Site's local DDEV CMS.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** A Chrome or Chromium: `CHROMIUM` or `CHROME` if set, else the first found. */
export function findChrome(env) {
  if (env.CHROMIUM || env.CHROME) return env.CHROMIUM || env.CHROME;
  const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = directories.map((directory) => join(directory, candidate)).find(existsSync);
    if (found) return found;
  }
  return null;
}

/**
 * Opens `url` in a fresh headless Chrome holding `cookies` (CDP CookieParams)
 * and evaluates `expression` every half second until its value has a `state`
 * other than "loading" or `timeoutMs` passes. Resolves to that value.
 */
export async function evaluateInPage({ binary, url, cookies, expression, timeoutMs = 120_000 }) {
  const profile = await mkdtemp(join(tmpdir(), "gq-content-chrome-"));
  // The certificate is DDEV's own (mkcert); the URL was checked to be the
  // local *.ddev.site CMS before this runs.
  const chrome = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--ignore-certificate-errors",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.once("error", () => {});
  let socket;
  try {
    const endpoint = await devToolsEndpoint(profile, exited);
    socket = await connect(endpoint);
    const { targetId } = await socket.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await socket.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => socket.send(method, params, sessionId);
    await page("Network.enable", {});
    await page("Network.setCookies", { cookies });
    await page("Page.navigate", { url });
    const deadline = Date.now() + timeoutMs;
    let last = { state: "loading" };
    while (Date.now() < deadline) {
      await sleep(500);
      const evaluated = await page("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }).catch(() => null);
      last = evaluated?.result?.value ?? last;
      if (last.state !== "loading") return last;
    }
    return { state: "timeout", ...last };
  } finally {
    socket?.close();
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    // Chrome can still be writing its profile as it exits.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      () => {},
    );
  }
}

async function devToolsEndpoint(profile, exited) {
  let gone = false;
  exited.then(() => {
    gone = true;
  });
  for (let attempt = 0; attempt < 100 && !gone; attempt += 1) {
    const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    const [port, path] = text.split("\n");
    if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    await sleep(100);
  }
  throw new Error("Chrome didn't start its DevTools endpoint.");
}

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    const pending = new Map();
    let next = 0;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiting = message.id === undefined ? null : pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    });
    ws.addEventListener("error", () => reject(new Error("Couldn't reach Chrome's DevTools.")));
    ws.addEventListener("open", () =>
      resolve({
        send(method, params, sessionId) {
          next += 1;
          const id = next;
          return new Promise((done, fail) => {
            pending.set(id, { resolve: done, reject: fail, method });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

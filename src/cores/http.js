export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How many responses may be in flight at once, on desktop and on Android.
// OkHttp's per-host cap matches this. A higher cap needs a new APK.
export const DOWNLOADS = 64;
// Chapters overlap so the next chapter's pages start before the previous one finishes.
export const CHAPTERS = 16;

let activeDownloads = 0;
const downloadQueue = [];

function takeSlot() {
  if (activeDownloads < DOWNLOADS) {
    activeDownloads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => downloadQueue.push(resolve));
}

function giveSlot() {
  const next = downloadQueue.shift();
  if (next) next();
  else activeDownloads -= 1;
}

async function withSlot(run) {
  await takeSlot();
  try {
    return await run();
  } finally {
    giveSlot();
  }
}

// Like pool, but `consume` runs in input order as soon as that item is ready,
// while later items keep downloading.
export async function pipeline(limit, items, worker, consume) {
  const list = [...items];
  if (!list.length) return;
  const results = new Array(list.length);
  const ready = new Array(list.length).fill(false);
  let next = 0;
  let cursor = 0;
  let chain = Promise.resolve();

  function schedule() {
    chain = chain.then(async () => {
      while (cursor < list.length && ready[cursor]) {
        const index = cursor;
        cursor += 1;
        await consume(results[index], index);
      }
    });
    return chain;
  }

  const runners = Math.max(1, Math.min(limit || 1, list.length));
  await Promise.all(
    Array.from({ length: runners }, async () => {
      while (next < list.length) {
        const index = next;
        next += 1;
        results[index] = await worker(list[index], index);
        ready[index] = true;
        await schedule();
      }
    }),
  );
  await chain;
}

// Runs `worker` on each item with at most `limit` calls in flight. Results stay in input order.
export async function pool(limit, items, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;
  const runners = Math.max(1, Math.min(limit || 1, list.length));
  await Promise.all(
    Array.from({ length: runners }, async () => {
      while (next < list.length) {
        const index = next;
        next += 1;
        results[index] = await worker(list[index], index);
      }
    }),
  );
  return results;
}

export function withParams(url, params) {
  if (!params) return url;
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item == null) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  if (!parts.length) return url;
  return url + (url.includes("?") ? "&" : "?") + parts.join("&");
}

function cookieLines(headers) {
  if (typeof headers?.getSetCookie === "function") {
    const lines = headers.getSetCookie();
    if (lines?.length) return lines;
  }
  const raw = headers?.get?.("set-cookie");
  if (!raw) return [];
  return String(raw).split(/,(?=\s*[^;,=\s]+=)/);
}

function rememberCookies(jar, headers) {
  if (!jar) return;
  for (const line of cookieLines(headers)) {
    const pair = String(line).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (value === "" || /(?:^|;\s*)max-age=0(?:;|$)/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function applyJar(headers, jar) {
  const merged = { ...headers };
  if (!jar?.size) return merged;
  const cookies = new Map();
  for (const part of String(merged.Cookie || merged.cookie || "").split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const [name, value] of jar) cookies.set(name, value);
  delete merged.cookie;
  merged.Cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  return merged;
}

function asResponse(res) {
  return res.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const headerMap = new Map();
    res.headers.forEach((value, key) => headerMap.set(String(key).toLowerCase(), value));
    const text = () => new TextDecoder().decode(bytes);
    return {
      status: res.status,
      bytes,
      headers: {
        get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
      },
      text,
      json: () => JSON.parse(text()),
    };
  });
}

// React Native's fetch base64-encodes every body, then Hermes decodes it on the
// only JS thread, so image downloads in the pool wait on each other. Android
// writes each body to a cache file. Pictures stay there until the EPUB is packed.
// Node and iOS stay on fetch.
let nativeExchange;
const pendingDownloads = new Set();

class StoredBytes {
  constructor(uri) {
    this.uri = uri;
    this.cached = null;
    pendingDownloads.add(this);
  }

  load() {
    if (this.cached) return this.cached;
    this.cached = readStored(this.uri);
    this.uri = "";
    pendingDownloads.delete(this);
    return this.cached;
  }

  discard() {
    if (!this.uri) return;
    const uri = this.uri;
    this.uri = "";
    pendingDownloads.delete(this);
    deleteStored(uri);
  }
}

export function releaseDownloads() {
  for (const item of [...pendingDownloads]) item.discard();
}

function fileApi() {
  return require("expo-file-system").File;
}

function readStored(uri) {
  const file = new (fileApi())(uri);
  try {
    return file.bytesSync();
  } finally {
    deleteStored(uri);
  }
}

function deleteStored(uri) {
  if (!uri) return;
  try {
    new (fileApi())(uri).delete();
  } catch {
    // The file was already removed, or this response was never saved.
  }
}

function androidExchange() {
  if (nativeExchange !== undefined) return nativeExchange;
  nativeExchange = null;
  if (typeof navigator === "undefined" || navigator.product !== "ReactNative") return null;
  try {
    const { requireNativeModule } = require("expo");
    const mod = requireNativeModule("DownloadProgress");
    nativeExchange = typeof mod?.exchange === "function" ? mod : null;
  } catch {
    nativeExchange = null;
  }
  return nativeExchange;
}

function flatHeaders(headers) {
  const flat = {};
  if (!headers) return flat;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    flat[key] = String(value);
  }
  return flat;
}

function responseFromNative(result) {
  const uri = typeof result?.file === "string" ? result.file : "";
  if (!uri) return undefined;
  const headerMap = new Map();
  for (const [key, value] of Object.entries(result.headers || {})) {
    if (value == null) continue;
    headerMap.set(String(key).toLowerCase(), String(value));
  }
  const type = (headerMap.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Chapter JSON and HTML are small. Page images are not: keep them on disk.
  const bytes = type.startsWith("image/") ? new StoredBytes(uri) : readStored(uri);
  const text = () => new TextDecoder().decode(typeof bytes.load === "function" ? bytes.load() : bytes);
  return {
    status: Number(result.status),
    bytes,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
    },
    text,
    json: () => JSON.parse(text()),
  };
}

async function exchangeAndroid(mod, url, { method, headers, body, timeout, redirect }) {
  const result = await mod.exchange(
    url,
    method || "GET",
    JSON.stringify(flatHeaders(headers)),
    body == null ? null : String(body),
    timeout || 20000,
    redirect || "follow",
  );
  const response = responseFromNative(result);
  if (response) return response;
  nativeExchange = null;
  return undefined;
}

async function exchangeFetch(url, { method = "GET", headers, body, timeout = 20000, redirect = "follow", jar } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect });
    rememberCookies(jar, res.headers);
    return await asResponse(res);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(url, options = {}) {
  const native = androidExchange();
  if (native) {
    try {
      const res = await exchangeAndroid(native, url, options);
      if (res !== undefined) {
        if (res) rememberCookies(options.jar, res.headers);
        return res;
      }
    } catch (error) {
      // A bad binary (missing method, wrong arguments) should keep working
      // through fetch. A dropped connection should retry this same path.
      if (error?.code && error.code !== "ERR_NETWORK") {
        nativeExchange = null;
        return exchangeFetch(url, options);
      }
      return null;
    }
  }
  return exchangeFetch(url, options);
}

export async function retryGet(url, { headers, params, timeout = 20000, attempts = 3, jar } = {}) {
  const target = withParams(url, params);
  for (let i = 0; i < attempts; i++) {
    const response = await withSlot(() => exchange(target, { headers, timeout, jar }));
    if (response?.status === 200) return response;
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  return null;
}

export class HttpClient {
  constructor(headers) {
    this.headers = { ...headers };
    this.jar = new Map();
  }

  get(url, options = {}) {
    return retryGet(url, {
      ...options,
      headers: applyJar({ ...this.headers, ...options.headers }, this.jar),
      jar: this.jar,
    });
  }

  // One attempt, including redirects the caller wants to see. Used for form posts.
  send(url, options = {}) {
    return withSlot(() =>
      exchange(withParams(url, options.params), {
        ...options,
        headers: applyJar({ ...this.headers, ...options.headers }, this.jar),
        jar: this.jar,
      }),
    );
  }
}

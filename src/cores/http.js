export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// fetch + AbortController + Uint8Array. All three exist in Node 18 and in React Native.
export async function retryGet(url, { headers, params, timeout = 20000, attempts = 3 } = {}) {
  const target = withParams(url, params);
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(target, { headers, signal: ctrl.signal });
      if (res.status === 200) {
        const bytes = new Uint8Array(await res.arrayBuffer());
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
      }
    } catch {
      // try the next attempt
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  return null;
}

export class HttpClient {
  constructor(headers) {
    this.headers = { ...headers };
  }

  get(url, options = {}) {
    return retryGet(url, {
      ...options,
      headers: { ...this.headers, ...options.headers },
    });
  }
}

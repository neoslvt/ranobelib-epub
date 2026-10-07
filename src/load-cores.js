import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scanned = new Map();

function asCore(mod, filename) {
  let obj = mod.CORE ?? mod.default;
  if (typeof obj === "function") obj = new obj();
  if (!obj || typeof obj.public !== "function") {
    console.error(`Skipping ${filename}: export const CORE = new YourCore()`);
    return null;
  }
  const stem = filename.replace(/\.js$/i, "");
  if (!obj.id) obj.id = stem;
  if (!obj.name) obj.name = obj.id;
  return obj;
}

// Node-only. Drop a .js file into the cores folder; it is picked up on the next request.
// React Native cannot scan a folder, so the mobile app should import src/cores/index.js
// and pass any extra cores into allCores() itself.
export async function loadExtraCores(dir) {
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith(".js") && !name.startsWith("_")).sort();
  const seen = new Set(files);
  for (const name of files) {
    const full = path.join(dir, name);
    let mtime;
    try {
      mtime = (await fs.promises.stat(full)).mtimeMs;
    } catch {
      continue;
    }
    const prev = scanned.get(name);
    if (prev && prev.mtime === mtime) continue;
    try {
      const mod = await import(`${pathToFileURL(full).href}?t=${mtime}`);
      scanned.set(name, { mtime, core: asCore(mod, name) });
    } catch (err) {
      console.error(`Skipping core ${name}: ${err.message}`);
      scanned.set(name, { mtime, core: null });
    }
  }
  for (const name of scanned.keys()) {
    if (!seen.has(name)) scanned.delete(name);
  }
  return [...scanned.values()].map((item) => item.core).filter(Boolean);
}

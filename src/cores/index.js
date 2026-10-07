import { CoreError } from "./base.js";
import { CORE as mangaCore } from "./mangalib.js";
import { CORE as ranobeCore } from "./ranobelib.js";

export { Core, CoreError } from "./base.js";
export { mangaCore, ranobeCore };

// Built-in sources, in the order the menu shows them. Extra cores passed in
// replace a built-in with the same id. This module does not read the disk.
const BUILTINS = [ranobeCore, mangaCore];

export function allCores(extra = []) {
  const extraIds = new Set(extra.map((core) => core.id));
  const merged = [...BUILTINS.filter((core) => !extraIds.has(core.id)), ...extra];
  const out = [];
  const seen = new Set();
  for (const core of merged) {
    if (!core?.id) continue;
    if (seen.has(core.id)) {
      console.error(`Skipping duplicate core id ${JSON.stringify(core.id)}`);
      continue;
    }
    seen.add(core.id);
    out.push(core);
  }
  return out;
}

export function getCore(coreId, extra = []) {
  const items = allCores(extra);
  if (!items.length) throw new CoreError("No sources are installed.", 500);
  if (!coreId) return items[0];
  const found = items.find((core) => core.id === coreId);
  if (!found) throw new CoreError("Unknown source.", 404);
  return found;
}

export function matchCore(query, extra = []) {
  const text = query || "";
  const found = [];
  for (const core of allCores(extra)) {
    const pattern = core.linkRe || "";
    if (!pattern) continue;
    try {
      if (new RegExp(pattern).test(text)) found.push(core);
    } catch {
      console.error(`Ignoring invalid link pattern on ${core.id}`);
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => (b.linkRe || "").length - (a.linkRe || "").length);
  return found[0];
}

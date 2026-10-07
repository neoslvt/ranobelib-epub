import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CoreError, allCores, getCore, matchCore } from "./cores/index.js";
import { loadExtraCores } from "./load-cores.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRA_DIR = path.join(ROOT, "cores");
const jobs = new Map();
let injected = [];

export function useExtraCores(cores) {
  injected = cores || [];
}

export function libraryDir() {
  return process.env.REPUB_LIBRARY
    ? path.resolve(process.env.REPUB_LIBRARY)
    : path.join(os.homedir(), "RanobeLibrary");
}

export async function ensureLibrary() {
  const dir = libraryDir();
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export async function listCores() {
  return allCores([...(await loadExtraCores(EXTRA_DIR)), ...injected]);
}

export async function searchBooks(coreId, query) {
  const list = await listCores();
  const core = getCore(coreId, list);
  const hits = (await core.search(query || "")) || [];
  return hits.map((hit) => ({ ...hit, core: core.id, source: core.name }));
}

export async function bookInfo(coreId, query) {
  const list = await listCores();
  const core = coreId ? getCore(coreId, list) : matchCore(query || "", list);
  if (!core) throw new CoreError("No source recognized that link.", 404);
  const payload = await core.info(query || "");
  payload.core = core.id;
  return payload;
}

export async function matchQuery(query) {
  return matchCore(query || "", await listCores());
}

export async function beginBuild(data) {
  const core = getCore(data?.core, await listCores());
  const id = randomBytes(4).toString("hex");
  const job = { done: 0, total: 0, state: "running", msg: "Starting…", file: null };
  jobs.set(id, job);
  runJob(id, core, data || {}, libraryDir());
  return { id };
}

export function readProgress(id) {
  const job = jobs.get(id);
  if (!job) return { state: "error", msg: "Unknown job" };
  return {
    done: job.done,
    total: job.total,
    state: job.state,
    msg: job.msg,
    file: job.file,
  };
}

export async function listBooks() {
  const dir = libraryDir();
  const names = await fs.promises.readdir(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".epub")) continue;
    const full = path.join(dir, name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    files.push({ name, mb: Math.round((stat.size / 1e6) * 10) / 10, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.map(({ name, mb }) => ({ name, mb }));
}

export function bookFile(name) {
  const base = path.basename(String(name || ""));
  if (!base.toLowerCase().endsWith(".epub")) return null;
  const full = path.resolve(libraryDir(), base);
  if (path.dirname(full) !== path.resolve(libraryDir())) return null;
  return full;
}

async function runJob(id, core, data, library) {
  const job = jobs.get(id);
  try {
    await fs.promises.mkdir(library, { recursive: true });
    const result = await core.build(job, data);
    const filename = path.basename(result.filename);
    await fs.promises.writeFile(path.join(library, filename), result.bytes);
    job.file = filename;
    job.state = "done";
    job.msg = "Ready";
  } catch (err) {
    job.state = "error";
    job.msg = err.message || String(err);
  }
}

export { CoreError };

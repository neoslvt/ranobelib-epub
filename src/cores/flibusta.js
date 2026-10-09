import { parse } from "node-html-parser";
import { unzipSync } from "fflate";
import { Core, CoreError } from "./base.js";
import { EpubBook, EpubItem, writeEpub } from "./epub.js";
import { HttpClient, pool } from "./http.js";
import { epubName, sameBranch, titleWithVolume } from "./kit.js";

const ORIGIN = "https://flibusta.is";
// Each file is a whole book, and the site builds it on the fly before the bytes start.
const EPUBS = 3;
const EPUB_TIMEOUT = 120000;

function decodeText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(path) {
  const value = String(path || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, ORIGIN).href;
}

function sectionHtml(html, heading) {
  const start = html.indexOf(heading);
  if (start < 0) return "";
  const ul = html.indexOf("<ul", start);
  const end = html.indexOf("</ul>", ul);
  if (ul < 0 || end < 0) return "";
  return html.slice(ul, end + 5);
}

function coverUrl(id) {
  const text = String(id || "");
  if (!/^\d+$/.test(text)) return "";
  return `${ORIGIN}/i/${text.slice(-2).padStart(2, "0")}/${text}/cover.jpg`;
}

function searchHits(html) {
  const hits = [];
  const series = sectionHtml(html, "Найденные серии");
  for (const match of series.matchAll(/<a href="\/sequence\/(\d+)"[^>]*>([\s\S]*?)<\/a>\s*\(([^)]+)\)/gi)) {
    hits.push({
      slug: `s:${match[1]}`,
      title: decodeText(match[2]),
      alt: "",
      cover: "",
      type: "Series",
      year: "",
      rating: "",
      status: decodeText(match[3]),
    });
  }
  const books = sectionHtml(html, "Найденные книги");
  for (const match of books.matchAll(
    /<a href="\/b\/(\d+)"[^>]*>([\s\S]*?)<\/a>(\s*\[[^\]]+\])?\s*(?:-\s*<a href="\/a\/\d+"[^>]*>([\s\S]*?)<\/a>)?/gi,
  )) {
    hits.push({
      slug: `b:${match[1]}`,
      title: decodeText(match[2]),
      alt: decodeText(match[4] || ""),
      cover: coverUrl(match[1]),
      type: "Book",
      year: "",
      rating: "",
      status: decodeText(match[3] || ""),
    });
  }
  return hits;
}

function parseEntries(html) {
  const entries = [];
  const seen = new Set();
  for (const row of String(html).split(/<br\s*\/?>/i)) {
    const id = /name="bchk(\d+)"/.exec(row)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = decodeText(new RegExp(`<a href="/b/${id}"[^>]*>([\\s\\S]*?)</a>`, "i").exec(row)?.[1] || "");
    const translator = decodeText(/пер\.\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(row)?.[1] || "");
    const etal = /пер\.\s*<a[^>]*>[\s\S]*?<\/a>\s*et al\./i.test(row);
    const note = /<\/a>\s*(\[[^\]]+\])/.exec(row)?.[1] || "";
    const pages = Number(/(\d+)\s*с\./.exec(row)?.[1] || 0);
    const epub = row.includes(`/b/${id}/epub`) || /скачать\s+epub/i.test(row);
    entries.push({
      id,
      title,
      translator: translator ? (etal ? `${translator} и др.` : translator) : "",
      note,
      pages,
      url: `${ORIGIN}/b/${id}/${epub ? "epub" : "download"}`,
    });
  }
  return entries;
}

function versionsList(title, entries) {
  if (/версии/i.test(title)) return true;
  if (entries.length < 2) return false;
  const titles = new Set(entries.map((entry) => entry.title.toLowerCase()));
  return titles.size === 1 && entries.some((entry) => entry.translator);
}

function translationName(entry) {
  const who = entry.translator || "Без переводчика";
  return entry.note ? `${who} ${entry.note}` : who;
}

function assignVolumes(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.title, (counts.get(entry.title) || 0) + 1);
  const used = new Map();
  return entries.map((entry, index) => {
    let volume = entry.title || String(index + 1);
    if ((counts.get(entry.title) || 0) > 1) {
      const n = (used.get(volume) || 0) + 1;
      used.set(volume, n);
      volume = `${volume} · ${entry.translator || entry.note || n}`;
    }
    return { ...entry, volume };
  });
}

function cellAfter(root, label) {
  for (const td of root.querySelectorAll("td")) {
    const text = td.text.replace(/\s+/g, " ").trim();
    if (text.startsWith(label)) return td.nextElementSibling;
  }
  return null;
}

function namesFrom(cell) {
  if (!cell) return [];
  const links = cell.querySelectorAll("a").map((link) => link.text.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (links.length) return links.filter((name) => name.toLowerCase() !== "разные");
  const text = cell.text.replace(/\s+/g, " ").trim();
  if (!text || text.toLowerCase() === "разные") return [];
  return [text];
}

function sequenceMeta(html) {
  const root = parse(html);
  const title = root.querySelector("h1.title")?.text?.replace(/\s+/g, " ").trim() || "";
  const genres = (cellAfter(root, "Жанры:")?.querySelectorAll("a") || [])
    .map((link) => link.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const publisher = /value="1"[^>]*checked/i.test(html);
  return {
    title,
    authors: namesFrom(cellAfter(root, "Авторы:")),
    translators: namesFrom(cellAfter(root, "Переводчики:")),
    genres,
    kind: publisher ? "Publisher series" : "Author series",
  };
}

function bookMeta(html, id) {
  const root = parse(html);
  const rawTitle = root.querySelector("h1.title")?.text?.replace(/\s+/g, " ").trim() || id;
  const title = rawTitle.replace(/\s*\((?:fb2|epub|mobi|pdf|djvu)\)\s*$/i, "").trim() || rawTitle;
  const translator = decodeText(/перевод:\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1] || "");
  const cover = absUrl(root.querySelector('img[src*="cover"]')?.getAttribute("src") || "");
  const year = /издание\s+(\d{4})/i.exec(html)?.[1] || "";
  const genres = root
    .querySelectorAll("a.genre")
    .map((link) => link.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const authors = [];
  for (const link of root.querySelectorAll('a[href^="/a/"]')) {
    const name = link.text.replace(/\s+/g, " ").trim();
    if (!name || name === translator) continue;
    authors.push(name);
    break;
  }
  const annotation = html.split(/<h2>\s*Аннотация\s*<\/h2>/i)[1] || "";
  const summary = (annotation.split(/<h2|<hr/i)[0].match(/<p[\s\S]*?<\/p>/gi) || []).join("");
  const series = [];
  for (const match of html.matchAll(/<a href="\/(?:s|sequence)\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const sid = match[1];
    if (series.some((item) => item.id === sid)) continue;
    series.push({ id: sid, title: decodeText(match[2]) });
  }
  const epub = html.includes(`/b/${id}/epub`) || /скачать\s+epub/i.test(html);
  return {
    id,
    title,
    translator,
    authors,
    genres,
    cover,
    year,
    summary,
    series,
    url: `${ORIGIN}/b/${id}/${epub ? "epub" : "download"}`,
  };
}

function describeSequence(id, meta, entries, preferId) {
  const versions = versionsList(meta.title, entries);
  let branches;
  let volumes;
  if (versions) {
    const ordered = [...entries];
    if (preferId) {
      ordered.sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : 0));
    }
    const names = new Map();
    branches = ordered.map((entry) => {
      let name = translationName(entry);
      const count = (names.get(name) || 0) + 1;
      names.set(name, count);
      if (count > 1) name = `${name} · ${entry.id}`;
      return { id: entry.id, name, chapters: 1 };
    });
    volumes = [{ v: "1", n: 1 }];
  } else {
    const labeled = assignVolumes(entries);
    volumes = labeled.map((entry) => ({ v: entry.volume, n: 1 }));
    const who = meta.translators.join(", ") || meta.authors.join(", ") || "Flibusta";
    branches = [{ id: "", name: who, chapters: entries.length }];
  }
  const shared = versions && entries.every((entry) => entry.title === entries[0].title) ? entries[0].title : "";
  return {
    alt: shared && shared !== meta.title ? meta.title : "",
    other: [],
    summary: "",
    genres: meta.genres,
    tags: [],
    authors: meta.authors,
    artists: [],
    notes: [],
    facts: [
      ["Series", meta.kind],
      ["Books", String(entries.length)],
    ].filter(([, value]) => value),
    slug: `s:${id}`,
    chapters: entries.length,
    title: shared || meta.title || id,
    cover: "",
    volumes,
    branches,
  };
}

function epubBytes(response) {
  const raw = response?.bytes;
  const bytes = typeof raw?.load === "function" ? raw.load() : raw;
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  return bytes;
}

function zipText(files, path) {
  const data = files[path];
  return data ? new TextDecoder().decode(data) : "";
}

function resolveZip(base, href) {
  try {
    const url = new URL(href, `https://local/${base}`);
    return decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

function opfItems(opf) {
  const items = [];
  for (const match of opf.matchAll(/<item\b([^>]*?)\/?>/gi)) {
    const attrs = match[1];
    const id = /(?:^|\s)id="([^"]+)"/i.exec(attrs)?.[1];
    const href = /href="([^"]+)"/i.exec(attrs)?.[1];
    const type = /media-type="([^"]+)"/i.exec(attrs)?.[1] || "";
    const props = /properties="([^"]+)"/i.exec(attrs)?.[1] || "";
    if (id && href) items.push({ id, href, type, props });
  }
  return items;
}

function spineRefs(opf) {
  const refs = [];
  for (const match of opf.matchAll(/<itemref\b([^>]*?)\/?>/gi)) {
    const id = /idref="([^"]+)"/i.exec(match[1])?.[1];
    if (id) refs.push(id);
  }
  return refs;
}

function coverItem(opf, items) {
  const meta =
    /<meta[^>]*name="cover"[^>]*content="([^"]+)"/i.exec(opf) ||
    /<meta[^>]*content="([^"]+)"[^>]*name="cover"/i.exec(opf);
  if (meta) {
    const found = items.find((item) => item.id === meta[1]);
    if (found) return found;
  }
  return items.find((item) => /cover-image/i.test(item.props) || /cover\.(jpe?g|png|webp|gif)$/i.test(item.href));
}

// Several downloaded books become one EPUB. One book is returned unchanged.
function stitch(parts, title) {
  const book = new EpubBook();
  book.setIdentifier(`flibusta-${title}`);
  book.setTitle(title);
  book.setLanguage("ru");
  const toc = [];
  const seen = new Set();
  let coverSet = false;
  for (const part of parts) {
    let files;
    try {
      files = unzipSync(part.bytes);
    } catch {
      throw new CoreError(`Couldn't read the EPUB for “${part.title || part.id}”.`, 502);
    }
    const container = zipText(files, "META-INF/container.xml");
    const opfPath = /full-path="([^"]+)"/i.exec(container)?.[1];
    if (!opfPath || !files[opfPath]) {
      throw new CoreError(`Couldn't read the EPUB for “${part.title || part.id}”.`, 502);
    }
    const opf = zipText(files, opfPath);
    const items = opfItems(opf);
    const byId = new Map(items.map((item) => [item.id, item]));
    const prefix = `b${part.id}`;
    const copied = new Map();
    for (const item of items) {
      if (/\/ncx\b/i.test(item.type) || /\bnav\b/i.test(item.props)) continue;
      const path = resolveZip(opfPath, item.href);
      const bytes = path ? files[path] : null;
      if (!bytes) continue;
      const fileName = `${prefix}/${path}`;
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      const stored = book.addItem(
        new EpubItem({
          uid: `f${seen.size}`,
          fileName,
          mediaType: item.type || "application/octet-stream",
          content: bytes,
        }),
      );
      copied.set(item.id, stored);
    }
    const pages = [];
    for (const id of spineRefs(opf)) {
      const stored = copied.get(id);
      if (!stored) continue;
      book.spine.push(stored);
      pages.push({ title: byId.get(id)?.href?.split("/").pop() || part.title, fileName: stored.fileName });
    }
    if (pages.length) toc.push({ title: part.title || `Книга ${part.id}`, children: [pages[0]] });
    if (!coverSet) {
      const cover = coverItem(opf, items);
      const path = cover ? resolveZip(opfPath, cover.href) : "";
      const bytes = path ? files[path] : null;
      if (bytes) {
        const ext = (path.split(".").pop() || "jpg").toLowerCase();
        book.setCover(`cover.${ext === "jpeg" ? "jpg" : ext}`, bytes);
        coverSet = true;
      }
    }
  }
  book.toc = toc;
  book.spine = ["nav", ...book.spine];
  return writeEpub(book);
}

export class Flibusta extends Core {
  id = "flibusta";
  name = "Flibusta";
  description = "flibusta.is";
  linkRe = String.raw`flibusta\.(?:is|site)/(?:b|s|sequence)/\d+`;
  placeholder = "Search by title or paste a link";

  constructor() {
    super();
    this.http = new HttpClient({
      Referer: `${ORIGIN}/`,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    this.pages = new Map();
  }

  extract(value) {
    const text = String(value || "").trim();
    const sequence = /(?:flibusta\.(?:is|site)\/)?(?:sequence|s)\/(\d+)/i.exec(text) || /^s:(\d+)$/i.exec(text);
    if (sequence && /sequence|\/s\/|^s:/i.test(text)) return { kind: "sequence", id: sequence[1] };
    const book = /(?:flibusta\.(?:is|site)\/)?b\/(\d+)/i.exec(text) || /^b:(\d+)$/i.exec(text);
    if (book) return { kind: "book", id: book[1] };
    throw new CoreError("Couldn't find that book. Check the link and try again.", 404);
  }

  async page(url) {
    if (!this.pages.has(url)) {
      const response = await this.http.get(url);
      const text = response ? response.text() : "";
      if (!text) throw new CoreError("Flibusta didn't respond. Check your connection and try again.", 502);
      this.pages.set(url, text);
    }
    return this.pages.get(url);
  }

  async sequencePages(id) {
    const chunks = [];
    let next = `${ORIGIN}/sequence/${id}`;
    const seen = new Set();
    while (next && !seen.has(next) && seen.size < 20) {
      seen.add(next);
      const html = await this.page(next);
      chunks.push(html);
      const link = /<li class="pager-next"[^>]*>\s*<a href="([^"]+)"/i.exec(html)?.[1];
      if (!link) break;
      const href = absUrl(link.replace(/&amp;/g, "&"));
      if (!/\/(?:sequence|s)\/\d+/.test(href)) break;
      next = href;
    }
    return chunks;
  }

  async sequenceInfo(id, preferId = "") {
    const chunks = await this.sequencePages(id);
    const entries = parseEntries(chunks.join("\n"));
    if (!entries.length) throw new CoreError("Couldn't find books in this series. Check the link and try again.", 404);
    const meta = sequenceMeta(chunks[0]);
    const info = describeSequence(id, meta, entries, preferId);
    const sample = entries.find((entry) => entry.id === preferId) || entries[0];
    try {
      const book = bookMeta(await this.page(`${ORIGIN}/b/${sample.id}`), sample.id);
      if (book.cover) info.cover = book.cover;
      if (book.summary) info.summary = book.summary;
      if (book.year) info.facts.unshift(["Year", book.year]);
      if (!info.authors.length && book.authors.length) info.authors = book.authors;
    } catch {
      // The series list is enough when the sample book page is slow.
    }
    return info;
  }

  async search(query) {
    const q = String(query || "").trim();
    if (!q) return [];
    const response = await this.http.get(`${ORIGIN}/booksearch`, { params: { ask: q } });
    if (!response) throw new CoreError("Search failed. Check your connection and try again.", 502);
    return searchHits(response.text());
  }

  async info(query) {
    const ref = this.extract(query);
    if (ref.kind === "sequence") return this.sequenceInfo(ref.id);
    const book = bookMeta(await this.page(`${ORIGIN}/b/${ref.id}`), ref.id);
    const versions = book.series.find((item) => /версии/i.test(item.title));
    const series = versions || book.series[0];
    if (series) {
      const info = await this.sequenceInfo(series.id, versions ? ref.id : "");
      if (book.cover) info.cover = book.cover;
      if (book.summary) info.summary = book.summary;
      if (book.authors.length) info.authors = book.authors;
      return info;
    }
    const who = book.translator || "Flibusta";
    return {
      alt: "",
      other: [],
      summary: book.summary,
      genres: book.genres,
      tags: [],
      authors: book.authors,
      artists: [],
      notes: [],
      facts: [["Year", book.year]].filter(([, value]) => value),
      slug: `b:${book.id}`,
      chapters: 1,
      title: book.title,
      cover: book.cover,
      volumes: [{ v: "1", n: 1 }],
      branches: [{ id: book.id, name: who, chapters: 1 }],
    };
  }

  async build(job, data) {
    const ref = this.extract(data.slug);
    let picked = [];
    if (ref.kind === "book") {
      const book = bookMeta(await this.page(`${ORIGIN}/b/${ref.id}`), ref.id);
      picked = [{ ...book, label: book.translator || book.title }];
    } else {
      const chunks = await this.sequencePages(ref.id);
      const entries = parseEntries(chunks.join("\n"));
      const title = sequenceMeta(chunks[0]).title;
      if (versionsList(title, entries)) {
        const entry = entries.find((item) => sameBranch(item.id, data.branch));
        if (!entry) throw new CoreError("That translation is no longer listed.", 404);
        picked = [{ ...entry, label: translationName(entry) }];
      } else {
        const wanted = new Set((data.volumes || []).map((volume) => String(volume)));
        picked = assignVolumes(entries)
          .filter((entry) => wanted.has(entry.volume))
          .map((entry) => ({ ...entry, label: entry.volume }));
      }
    }
    if (!picked.length) throw new Error("No books could be retrieved.");
    job.total = picked.length;
    const files = await pool(EPUBS, picked, async (entry) => {
      job.msg = entry.translator ? `Перевод: ${entry.label}` : `Том ${entry.label}`;
      const response = await this.http.get(entry.url, {
        timeout: EPUB_TIMEOUT,
        headers: {
          Referer: `${ORIGIN}/`,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      const bytes = epubBytes(response);
      if (!bytes) {
        throw new CoreError(`Flibusta did not return an EPUB for “${entry.title || entry.id}”.`, 502);
      }
      job.done += 1;
      return { ...entry, bytes };
    });
    const singleVolume = (data.volumes || []).length === 1 && String(data.volumes[0]) === "1";
    const name = singleVolume
      ? data.team
        ? `${data.title} — ${data.team}`
        : data.title
      : titleWithVolume(data.title, data.volumes);
    if (files.length === 1) return { filename: epubName(name), bytes: files[0].bytes };
    job.msg = "Packing the EPUB…";
    return { filename: epubName(name), bytes: stitch(files, name) };
  }
}

export const CORE = new Flibusta();

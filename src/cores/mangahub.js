import { parse } from "node-html-parser";
import { Core, CoreError } from "./base.js";
import { EpubBook, EpubHtml, EpubItem, writeEpub } from "./epub.js";
import { HttpClient, pool, sleep } from "./http.js";
import {
  chapterFile,
  epubName,
  escapeHtml,
  fnum,
  sameBranch,
  stylesheet,
  titleWithVolume,
  volumeKey,
} from "./kit.js";

const SITE = "https://mangahub.ru";

const IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function text(node) {
  return String(node?.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return SITE + url;
  return url;
}

function chapterLabel(label) {
  const value = String(label || "").replace(/\s+/g, " ").trim();
  const full = /^Том\s+([\d.]+)\.\s*Глава\s+([\d.]+)(?:\s*[-–—]\s*(.*))?$/u.exec(value);
  if (full) return { volume: full[1], number: full[2], name: (full[3] || "").trim() };
  const only = /^Глава\s+([\d.]+)(?:\s*[-–—]\s*(.*))?$/u.exec(value);
  if (only) return { volume: "1", number: only[1], name: (only[2] || "").trim() };
  return null;
}

function readAnchor(node) {
  const href = node?.getAttribute?.("href") || "";
  if (href.startsWith("/read/")) return node;
  return node?.querySelector?.('a[href^="/read/"]') || null;
}

function parseChapters(html, team) {
  const root = parse(String(html || ""));
  const items = root.querySelectorAll('[data-targets="chapter-list.chapters"]');
  const nodes = items.length ? items : root.querySelectorAll("a.reader-chapter");
  const seen = new Set();
  const chapters = [];
  const teams = [{ name: team || "MangaHub" }];
  for (const node of nodes) {
    const link = readAnchor(node);
    const id = /\/read\/(\d+)/.exec(link?.getAttribute("href") || "")?.[1];
    const label = chapterLabel(text(link));
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    chapters.push({
      id,
      volume: label.volume,
      number: label.number,
      name: label.name,
      branches: [{ branch_id: "", teams }],
    });
  }
  return chapters;
}

function attrMap(root) {
  const attrs = new Map();
  for (const row of root.querySelectorAll(".attrs .attr")) {
    const name = text(row.querySelector(".attr-name"));
    const value = text(row.querySelector(".attr-value"));
    if (!name || !value) continue;
    const prev = attrs.get(name);
    if (!prev || value.length > prev.length) attrs.set(name, value);
  }
  return attrs;
}

function namesFrom(root, selector) {
  const names = [];
  for (const link of root.querySelectorAll(selector)) {
    const name = text(link).replace(/^#/, "");
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function attrLinks(root, label, hrefPrefix) {
  const names = [];
  for (const row of root.querySelectorAll(".attrs .attr")) {
    if (text(row.querySelector(".attr-name")) !== label) continue;
    for (const link of row.querySelectorAll("a")) {
      const href = link.getAttribute("href") || "";
      if (hrefPrefix && !href.startsWith(hrefPrefix)) continue;
      const name = text(link).replace(/^#/, "");
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function subtitleOf(heading) {
  let cursor = heading?.nextElementSibling;
  while (cursor) {
    const cls = String(cursor.getAttribute?.("class") || "").split(/\s+/);
    if (cls.includes("fs-2")) return cursor;
    cursor = cursor.nextElementSibling;
  }
  return null;
}

function parseTitle(html) {
  const root = parse(String(html || ""));
  const attrs = attrMap(root);
  const bits = [];
  const subtitle = subtitleOf(root.querySelector("h1"));
  for (const span of subtitle?.querySelectorAll("span") || []) {
    const bit = text(span);
    if (bit) bits.push(bit);
  }
  let type = "";
  let year = "";
  let status = "";
  let age = "";
  for (const bit of bits) {
    if (/^\d{4}$/.test(bit)) year = bit;
    else if (/^\d+\+$/.test(bit)) age = bit;
    else if (!type) type = bit;
    else if (!status) status = bit;
  }
  const otherNames = (attrs.get("Другие названия") || "")
    .split(/\s*\/\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
  const summaryNode = root.querySelector(".text-expandable-content");
  const paragraphs = summaryNode?.querySelectorAll("p") || [];
  const summaryParts = (paragraphs.length ? paragraphs : summaryNode ? [summaryNode] : [])
    .map((node) => text(node))
    .filter(Boolean);
  const rate = text(root.querySelector(".rating-star-rate"));
  const votes = text(root.querySelector(".rating-star-votes"));
  return {
    title: text(root.querySelector("h1")),
    alt: otherNames[0] || "",
    other: otherNames.slice(1),
    summary: summaryParts.map((part) => `<p>${escapeHtml(part)}</p>`).join(""),
    genres: namesFrom(root, 'a.tag[href^="/genre/"]'),
    tags: namesFrom(root, 'a.tag[href^="/tags/"]'),
    authors: attrLinks(root, "Автор", "/person/"),
    artists: attrLinks(root, "Художник", "/person/"),
    translators: attrLinks(root, "Переводчики", "/team/"),
    publisher: attrLinks(root, "Издательство", "/publisher/").join(", "),
    type,
    year,
    status,
    age,
    translation: attrs.get("Перевод") || "",
    country: attrs.get("Страна") || "",
    views: text(root.querySelector('[data-target="views-counter.output"]')),
    rating: rate ? `${rate}${votes ? ` (${votes} votes)` : ""}` : "",
    cover: absUrl(root.querySelector('meta[property="og:image"]')?.getAttribute("content") || ""),
  };
}

function parseSearch(html) {
  const root = parse(String(html || ""));
  const hits = [];
  for (const item of root.querySelectorAll("li.header-search-item")) {
    const href = item.querySelector("a")?.getAttribute("href") || "";
    const slug = /\/title\/([a-zA-Z0-9_]+)/.exec(href)?.[1];
    if (!slug) continue;
    const raw = text(item.querySelector(".fw-bold"));
    const [title, ...rest] = raw.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    const muted = [...item.querySelectorAll(".text-muted")].map((node) => text(node)).filter(Boolean);
    hits.push({
      slug,
      title: title || item.querySelector("img")?.getAttribute("alt") || slug,
      alt: rest.join(" / "),
      cover: absUrl(item.querySelector("img")?.getAttribute("src") || ""),
      type: muted.find((bit) => !/^\d{4}$/.test(bit)) || "",
      year: muted.find((bit) => /^\d{4}$/.test(bit)) || "",
      rating: "",
      status: "",
    });
  }
  return hits;
}

function pageUrls(html) {
  const root = parse(String(html || ""));
  const urls = [];
  for (const scan of root.querySelectorAll("reader-scan, .reader-viewer-scan")) {
    const img = scan.querySelector("img");
    const url = absUrl(img?.getAttribute("data-src") || img?.getAttribute("src") || "");
    if (url) urls.push(url);
  }
  return urls;
}

function ageGate(html) {
  return String(html || "").includes("confirm_age[_token]");
}

function ageToken(html) {
  const input = /<input[^>]*name="confirm_age\[_token\]"[^>]*>/i.exec(String(html || ""))?.[0] || "";
  return /value="([^"]*)"/.exec(input)?.[1] || "";
}

export class MangaHub extends Core {
  id = "mangahub";
  name = "MangaHub";
  description = "mangahub.ru";
  linkRe = String.raw`mangahub\.ru`;
  placeholder = "Search by title or paste a link";

  constructor() {
    super();
    this.http = new HttpClient({
      Referer: `${SITE}/`,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    });
    this.http.jar.set("confirm_age", "1");
    this.cache = new Map();
    this.chapterPause = 0;
    this.imageSlots = 6;
  }

  extractSlug(value) {
    const textValue = String(value || "").trim();
    const title = /\/title\/([a-zA-Z0-9_]+)/.exec(textValue);
    if (title) return title[1];
    if (/^[a-zA-Z0-9_]+$/.test(textValue)) return textValue;
    return "";
  }

  async resolveSlug(query) {
    const direct = this.extractSlug(query);
    if (direct && !/\/read\/\d+/.test(String(query || ""))) return direct;
    const readId = /\/read\/(\d+)/.exec(String(query || ""))?.[1];
    if (!readId) return direct;
    const html = await this.readChapter(`${SITE}/read/${readId}`);
    const slug = /\/title\/([a-zA-Z0-9_]+)/.exec(html)?.[1];
    if (!slug) throw new CoreError("Couldn't find that chapter. Check the link and try again.", 404);
    return slug;
  }

  async readChapter(url) {
    let response = await this.http.get(url);
    let html = response ? response.text() : "";
    if (!ageGate(html)) return html;
    const token = ageToken(html);
    if (!token) {
      throw new CoreError("MangaHub is asking to confirm you are 18 before it shows this chapter.", 403);
    }
    const posted = await this.http.send(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Referer: url,
        Origin: SITE,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "confirm_age[_token]": token,
        "confirm_age[dismissAlways]": "1",
      }).toString(),
    });
    const postedHtml = posted ? posted.text() : "";
    if (postedHtml && !ageGate(postedHtml) && pageUrls(postedHtml).length) return postedHtml;
    const next = absUrl(posted?.headers.get("location") || url);
    response = await this.http.get(next);
    html = response ? response.text() : "";
    if (ageGate(html)) {
      throw new CoreError("MangaHub is asking to confirm you are 18 before it shows this chapter.", 403);
    }
    return html;
  }

  async chapters(slug) {
    if (!this.cache.has(slug)) {
      const response = slug ? await this.http.get(`${SITE}/title/${slug}/chapters`) : null;
      const list = parseChapters(response ? response.text() : "");
      if (!list.length) throw new CoreError("Couldn't find chapters. Check the link and try again.", 404);
      this.cache.set(slug, list);
    }
    return this.cache.get(slug);
  }

  async search(query) {
    const q = String(query || "").trim();
    const response = q
      ? await this.http.get(`${SITE}/suggestions`, {
          params: { type: "title", query: q },
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" },
        })
      : null;
    if (!response) throw new CoreError("Search failed. Check your connection and try again.", 502);
    return parseSearch(response.text());
  }

  async info(query) {
    const slug = await this.resolveSlug(query);
    const response = slug ? await this.http.get(`${SITE}/title/${slug}`) : null;
    const meta = parseTitle(response ? response.text() : "");
    const chapters = await this.chapters(slug);
    const team = meta.translators.join(", ");
    if (team) {
      for (const chapter of chapters) {
        chapter.branches = [{ branch_id: "", teams: meta.translators.map((name) => ({ name })) }];
      }
    }
    const volumes = new Map();
    for (const chapter of chapters) volumes.set(chapter.volume, (volumes.get(chapter.volume) || 0) + 1);
    const facts = [
      ["Year", meta.year],
      ["Status", meta.status],
      ["Translation", meta.translation],
      ["Age", meta.age],
      ["Rating", meta.rating],
      ["Views", meta.views],
      ["Origin", meta.type],
      ["Country", meta.country],
      ["Publisher", meta.publisher],
    ].filter(([, value]) => value);
    const fallback = String(slug || "")
      .replaceAll("_", " ")
      .replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
    return {
      alt: meta.alt,
      other: meta.other,
      summary: meta.summary,
      genres: meta.genres,
      tags: meta.tags,
      authors: meta.authors,
      artists: meta.artists,
      notes: meta.age === "18+" ? ["18+"] : [],
      facts,
      slug,
      chapters: chapters.length,
      title: meta.title || fallback,
      cover: meta.cover,
      volumes: [...volumes.entries()]
        .sort((a, b) => fnum(a[0]) - fnum(b[0]))
        .map(([volume, count]) => ({ v: volume, n: count })),
      branches: [
        {
          id: "",
          chapters: chapters.length,
          name: team || "MangaHub",
        },
      ],
    };
  }

  async build(job, data) {
    const slug = data.slug;
    const branchId = data.branch;
    const volumes = new Set((data.volumes || []).map((volume) => String(volume)));
    const chapters = (await this.chapters(slug))
      .filter((chapter) => volumes.has(String(chapter.volume)))
      .sort((a, b) => fnum(a.volume) - fnum(b.volume) || fnum(a.number) - fnum(b.number));
    job.total = chapters.length;
    const title = titleWithVolume(data.title, data.volumes);
    const book = new EpubBook();
    book.setIdentifier(`mangahub-${slug}-${volumeKey(data.volumes)}`);
    book.setTitle(title);
    book.setLanguage("ru");
    const css = stylesheet();
    book.addItem(css);

    let cover = "";
    if (data.cover) {
      const response = await this.http.get(data.cover);
      if (response) {
        book.setCover("cover.jpg", response.bytes);
        cover = '<img src="cover.jpg" alt=""/>';
      }
    }
    const titlePage = new EpubHtml({ title: "Обложка", fileName: "title.xhtml", lang: "ru" });
    titlePage.content = `<div class="cover">${cover}
            <h1>${escapeHtml(title)}</h1>
            <p><a href="https://github.com/neoslvt/ranobelib-epub">ranobelib-epub by Neoslvt</a></p>
            <p>Translated by ${escapeHtml(data.team ?? "")}</p>
        </div>`;
    titlePage.addItem(css);
    book.addItem(titlePage);

    const groups = new Map();
    const pages = [];
    const counter = { n: 0 };
    for (const chapter of chapters) {
      const volume = chapter.volume;
      const number = chapter.number;
      const name = chapter.name || "";
      const branches = chapter.branches || [];
      if (!branches.length) continue;
      if (!branches.some((item) => sameBranch(item.branch_id, branchId))) continue;
      job.msg = `Том ${volume}, глава ${number}`;
      const html = await this.readChapter(`${SITE}/read/${chapter.id}`);
      const shots = pageUrls(html);
      const chapterTitle = `Глава ${number}${name ? `: ${name}` : ""}`;
      let ready = 0;
      const downloaded = await pool(this.imageSlots, shots, async (shot) => {
        const image = await this.http.get(shot);
        ready += 1;
        job.msg = `Том ${volume}, глава ${number} · ${ready}/${shots.length}`;
        const type = (image?.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!image || !type.startsWith("image/")) return null;
        return { bytes: image.bytes, ext: IMAGE_EXT[type] || "jpg" };
      });
      let first = null;
      for (let i = 0; i < downloaded.length; i++) {
        const image = downloaded[i];
        if (!image) continue;
        counter.n += 1;
        const fileName = `images/img_${counter.n}.${image.ext}`;
        book.addItem(
          new EpubItem({
            uid: `img${counter.n}`,
            fileName,
            mediaType: `image/${image.ext === "jpg" ? "jpeg" : image.ext}`,
            content: image.bytes,
          }),
        );
        const page = new EpubHtml({
          title: i ? "Страница" : chapterTitle,
          fileName: chapterFile(volume, number, i),
          lang: "ru",
        });
        page.content = `<div class="pic"><img src="${fileName}" alt=""/></div>`;
        page.addItem(css);
        book.addItem(page);
        pages.push(page);
        if (!first) first = page;
      }
      if (first) {
        const list = groups.get(volume) || [];
        list.push(first);
        groups.set(volume, list);
      }
      job.done += 1;
      if (this.chapterPause) await sleep(this.chapterPause);
    }

    if (!groups.size) throw new Error("No chapter pages could be retrieved.");
    const starts = [...groups.values()].flat();
    book.toc =
      groups.size > 1
        ? [...groups.entries()].map(([volume, group]) => ({ title: `Том ${volume}`, children: group }))
        : starts;
    book.spine = [titlePage, "nav", ...pages];
    job.msg = "Packing the EPUB…";
    await sleep(250);
    return { filename: epubName(title), bytes: writeEpub(book) };
  }
}

export const CORE = new MangaHub();

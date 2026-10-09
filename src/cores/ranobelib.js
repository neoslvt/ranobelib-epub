import { Core, CoreError } from "./base.js";
import { EpubBook, EpubHtml, writeEpub } from "./epub.js";
import { DOWNLOADS, HttpClient, pipeline, sleep } from "./http.js";
import {
  attachmentMap,
  buildInfo,
  chapterFile,
  epubName,
  escapeHtml,
  hasText,
  mapHit,
  pmHtml,
  sameBranch,
  splitMarkers,
  stylesheet,
  tidy,
  titleWithVolume,
  volumeKey,
  fnum,
} from "./kit.js";

const API = "https://api.cdnlibs.org/api/manga";

export class RanobeLib extends Core {
  id = "ranobelib";
  name = "RanobeLib";
  description = "ranobelib.me";
  linkRe = String.raw`ranobelib\.me|\d+--[\w-]+`;
  placeholder = "Search by title or paste a link";

  constructor() {
    super();
    this.http = new HttpClient({
      Referer: "https://ranobelib.me/",
      "Site-Id": "3",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      "Client-Time-Zone": "Asia/Almaty",
    });
    this.cache = new Map();
    this.chapterPause = 0;
  }

  extractSlug(value) {
    const match = /([0-9]+--[a-zA-Z0-9-]+)/.exec(value || "");
    return match ? match[1] : String(value || "").trim().replace(/^\/+|\/+$/g, "");
  }

  async chapters(slug) {
    if (!this.cache.has(slug)) {
      const response = slug ? await this.http.get(`${API}/${slug}/chapters`) : null;
      const list = response ? response.json().data || [] : [];
      if (!list.length) throw new CoreError("Couldn't find chapters. Check the link and try again.", 404);
      this.cache.set(slug, list);
    }
    return this.cache.get(slug);
  }

  async search(query) {
    const q = String(query || "").trim();
    const response = q
      ? await this.http.get(API, {
          params: { q, "site_id[]": 3, "fields[]": ["rate_avg", "releaseDate"] },
        })
      : null;
    if (!response) throw new CoreError("Search failed. Check your connection and try again.", 502);
    return (response.json().data || []).map(mapHit);
  }

  async info(query) {
    const slug = this.extractSlug(query);
    const chapters = await this.chapters(slug);
    const response = await this.http.get(`${API}/${slug}`, {
      params: {
        "fields[]": [
          "eng_name",
          "otherNames",
          "summary",
          "releaseDate",
          "views",
          "rate_avg",
          "rate",
          "genres",
          "tags",
          "authors",
          "artists",
          "format",
        ],
      },
    });
    const meta = response ? response.json().data || {} : {};
    return buildInfo(meta, slug, chapters);
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
    book.setIdentifier(`ranobe-${slug}-${volumeKey(data.volumes)}`);
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
    await pipeline(
      DOWNLOADS,
      chapters,
      async (chapter) => {
        const volume = chapter.volume;
        const number = chapter.number;
        const name = chapter.name || "";
        const branches = chapter.branches || [];
        if (!branches.length) return null;
        const branch = branches.find((item) => sameBranch(item.branch_id, branchId)) || branches[0];
        job.msg = `Том ${volume}, глава ${number}`;
        const response = await this.http.get(`${API}/${slug}/chapter`, {
          params: { volume, number, branch_id: branch.branch_id },
        });
        const payload = response ? response.json().data || {} : {};
        let content = payload.content;
        if (content && typeof content === "object") {
          content = pmHtml(content, attachmentMap(payload.attachments, "https://ranobelib.me"));
        }
        if (!content) {
          job.done += 1;
          if (this.chapterPause) await sleep(this.chapterPause);
          return null;
        }
        const html = await tidy(content, book, counter, (url) => this.http.get(url));
        job.done += 1;
        if (this.chapterPause) await sleep(this.chapterPause);
        return { volume, number, name, html };
      },
      async (ready) => {
        if (!ready) return;
        const sub = ready.name ? `<br/>${escapeHtml(ready.name)}` : "";
        const head = `<h2 class="ch">Глава ${ready.number}${sub}</h2>`;
        const chapterTitle = `Глава ${ready.number}${ready.name ? `: ${ready.name}` : ""}`;
        const parts = splitMarkers(ready.html);
        let first = null;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          let page;
          if (i % 2) {
            page = new EpubHtml({
              title: "Иллюстрация",
              fileName: chapterFile(ready.volume, ready.number, i),
              lang: "ru",
            });
            const imageUrl = String(part || "");
            const imageName = imageUrl.split("/").pop() || "image";
            page.content = `<div class="pic"><img src="${imageUrl}" alt="${imageName}"/></div>`;
          } else {
            if (i && !hasText(part)) continue;
            page = new EpubHtml({
              title: chapterTitle,
              fileName: chapterFile(ready.volume, ready.number, i),
              lang: "ru",
            });
            page.content = `${i ? "" : head}<div class="txt">${part}</div>`;
          }
          page.addItem(css);
          book.addItem(page);
          pages.push(page);
          if (!i) first = page;
        }
        const list = groups.get(ready.volume) || [];
        list.push(first);
        groups.set(ready.volume, list);
      },
    );

    if (!groups.size) throw new Error("No chapter text could be retrieved.");
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

export const CORE = new RanobeLib();

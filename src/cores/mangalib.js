import { Core, CoreError } from "./base.js";
import { EpubBook, EpubHtml, EpubItem, writeEpub } from "./epub.js";
import { HttpClient, sleep } from "./http.js";
import {
  buildInfo,
  chapterFile,
  epubName,
  escapeHtml,
  fnum,
  mapHit,
  sameBranch,
  stylesheet,
  titleWithVolume,
  volumeKey,
} from "./kit.js";

const API = "https://api.cdnlibs.org/api/manga";
const INFO_FIELDS = [
  "background",
  "eng_name",
  "otherNames",
  "summary",
  "releaseDate",
  "type_id",
  "caution",
  "views",
  "close_view",
  "rate_avg",
  "rate",
  "genres",
  "tags",
  "teams",
  "user",
  "franchise",
  "authors",
  "publisher",
  "userRating",
  "moderated",
  "metadata",
  "metadata.count",
  "metadata.close_comments",
  "translation_quality_rating",
  "manga_status_id",
  "chap_count",
  "status_id",
  "artists",
  "format",
];

const IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function chapterLocked(payload) {
  if (payload?.bundle && payload.bundle.is_open === false) return true;
  if (payload?.restricted_view && payload.restricted_view.is_open === false) return true;
  return false;
}

export class MangaLib extends Core {
  id = "mangalib";
  name = "MangaLib";
  description = "mangalib.me";
  linkRe = String.raw`mangalib\.me|\d+--[\w-]+`;
  placeholder = "Search by title or paste a link";

  constructor() {
    super();
    this.http = new HttpClient({
      Referer: "https://mangalib.me/",
      "Site-Id": "1",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      "Client-Time-Zone": "Asia/Almaty",
      "Content-Type": "application/json",
    });
    this.cache = new Map();
    this.imageRootUrl = "";
    this.chapterPause = 150;
  }

  extractSlug(value) {
    const match = /([0-9]+--[a-zA-Z0-9-]+)/.exec(value || "");
    return match ? match[1] : String(value || "").trim().replace(/^\/+|\/+$/g, "");
  }

  async imageRoot() {
    if (this.imageRootUrl) return this.imageRootUrl;
    let root = "https://img3.cdnlibs.org";
    const response = await this.http.get("https://api.cdnlibs.org/api/constants", {
      params: { "fields[]": ["imageServers"] },
    });
    const servers = response ? response.json().data?.imageServers || [] : [];
    for (const server of servers) {
      if (server?.id === "download" && (server.site_ids || []).includes(1) && server.url) {
        root = String(server.url).replace(/\/+$/, "");
        break;
      }
    }
    this.imageRootUrl = root;
    return root;
  }

  async pageUrl(path) {
    let value = String(path || "");
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
    if (value.startsWith("//")) value = value.slice(1);
    if (value && !value.startsWith("/")) value = `/${value}`;
    return (await this.imageRoot()) + value;
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
          params: { q, "site_id[]": 1, "fields[]": ["rate_avg", "releaseDate"] },
        })
      : null;
    if (!response) throw new CoreError("Search failed. Check your connection and try again.", 502);
    return (response.json().data || []).map(mapHit);
  }

  async info(query) {
    const slug = this.extractSlug(query);
    const chapters = await this.chapters(slug);
    const response = await this.http.get(`${API}/${slug}`, { params: { "fields[]": INFO_FIELDS } });
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
    book.setIdentifier(`manga-${slug}-${volumeKey(data.volumes)}`);
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
    let tried = 0;
    let locked = 0;
    for (const chapter of chapters) {
      const volume = chapter.volume;
      const number = chapter.number;
      const name = chapter.name || "";
      const branches = chapter.branches || [];
      if (!branches.length) continue;
      tried += 1;
      const branch = branches.find((item) => sameBranch(item.branch_id, branchId)) || branches[0];
      job.msg = `Том ${volume}, глава ${number}`;
      const response = await this.http.get(`${API}/${slug}/chapter`, {
        params: { volume, number, branch_id: branch.branch_id },
      });
      const payload = response ? response.json().data || {} : {};
      const shots = [...(payload.pages || [])].sort((a, b) => fnum(a.slug) - fnum(b.slug));
      if (!shots.length && chapterLocked(payload)) locked += 1;
      const chapterTitle = `Глава ${number}${name ? `: ${name}` : ""}`;
      let first = null;
      for (let i = 0; i < shots.length; i++) {
        job.msg = `Том ${volume}, глава ${number} · ${i + 1}/${shots.length}`;
        const image = await this.http.get(await this.pageUrl(shots[i]?.url));
        const type = (image?.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!image || !type.startsWith("image/")) continue;
        const ext = IMAGE_EXT[type] || "jpg";
        counter.n += 1;
        const fileName = `images/img_${counter.n}.${ext}`;
        book.addItem(
          new EpubItem({
            uid: `img${counter.n}`,
            fileName,
            mediaType: `image/${ext === "jpg" ? "jpeg" : ext}`,
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
      await sleep(this.chapterPause);
    }

    if (!groups.size) {
      if (locked && locked === tried) {
        throw new CoreError(
          "These chapters are in a paid volume. Page images are available after that volume is purchased.",
          403,
        );
      }
      throw new Error("No chapter pages could be retrieved.");
    }
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

export const CORE = new MangaLib();

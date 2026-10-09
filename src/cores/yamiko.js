import { Core, CoreError } from "./base.js";
import { EpubBook, EpubHtml, writeEpub } from "./epub.js";
import { CHAPTERS, HttpClient, pipeline, sleep } from "./http.js";
import {
  appendPictures,
  epubName,
  escapeHtml,
  fetchImages,
  fnum,
  sameBranch,
  stylesheet,
  titleWithVolume,
  volumeKey,
} from "./kit.js";

const ORIGIN = "https://yamiko.me";
const API = `${ORIGIN}/api`;

const STATUS = {
  finished: "Finished",
  ongoing: "Ongoing",
  paused: "Paused",
  dropped: "Dropped",
  announced: "Announced",
};

function labelOf(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function people(value) {
  return String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function ratingText(value, count) {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) return "";
  const shown = score.toFixed(2);
  return count ? `${shown} (${count})` : shown;
}

function branchKey(chapter) {
  if (chapter?.branch_id != null && chapter.branch_id !== "") return `b:${chapter.branch_id}`;
  if (chapter?.team?.id != null && chapter.team.id !== "") return `t:${chapter.team.id}`;
  if (chapter?.translator_team) return `n:${chapter.translator_team}`;
  return "";
}

function branchLabel(chapter, fallback) {
  return chapter?.team?.name || chapter?.translator_team || fallback || "Yamiko";
}

function chapterLocked(payload) {
  if (payload?.is_locked || payload?.team_sub_gated) return true;
  const chapter = payload?.chapter;
  return Boolean(chapter?.is_premium && !(payload?.pages || []).length);
}

function summaryHtml(text) {
  return escapeHtml(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br/>");
}

export class Yamiko extends Core {
  id = "yamiko";
  name = "Yamiko";
  description = "yamiko.me";
  linkRe = String.raw`yamiko\.me/manga/\d+`;
  placeholder = "Search by title or paste a link";

  constructor() {
    super();
    this.http = new HttpClient({
      Referer: `${ORIGIN}/`,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      "x-yamiko-web": "1",
    });
    this.cache = new Map();
    this.chapterPause = 0;
  }

  extractId(value) {
    const text = String(value || "").trim();
    const fromLink = /yamiko\.me\/manga\/(\d+)/i.exec(text);
    if (fromLink) return fromLink[1];
    const bare = /^(\d+)(?:-[\w-]+)?$/.exec(text);
    return bare ? bare[1] : text;
  }

  async chapters(id) {
    if (!this.cache.has(id)) {
      const response = id
        ? await this.http.get(`${API}/titles/${encodeURIComponent(id)}/chapters`, {
            params: { order: "asc" },
          })
        : null;
      const list = response ? response.json() : [];
      if (!Array.isArray(list) || !list.length) {
        throw new CoreError("Couldn't find chapters. Check the link and try again.", 404);
      }
      this.cache.set(id, list);
    }
    return this.cache.get(id);
  }

  async bundle(id) {
    const response = await this.http.get(`${API}/titles/${encodeURIComponent(id)}/bundle`);
    const payload = response ? response.json() : null;
    if (!payload?.title?.id) throw new CoreError("Couldn't open this title. Check the link and try again.", 404);
    return payload;
  }

  async search(query) {
    const q = String(query || "").trim();
    const response = q
      ? await this.http.get(`${API}/catalog`, { params: { q, per_page: 24 } })
      : null;
    if (!response) throw new CoreError("Search failed. Check your connection and try again.", 502);
    return (response.json().items || []).map((row) => ({
      slug: String(row.id),
      title: row.title_ru || row.title_orig || "",
      alt: row.title_orig && row.title_orig !== row.title_ru ? row.title_orig : "",
      cover: row.cover_m400_url || row.cover_thumb_url || row.cover_url || "",
      type: labelOf(row.type),
      year: row.year || "",
      rating: ratingText(row.rating),
      status: STATUS[row.status] || labelOf(row.status),
    }));
  }

  async info(query) {
    const id = this.extractId(query);
    const [payload, chapters] = await Promise.all([this.bundle(id), this.chapters(id)]);
    const meta = payload.title;
    const fallback = meta.translator_team_name || "Yamiko";
    const vols = new Map();
    const branches = new Map();
    for (const chapter of chapters) {
      const volume = String(chapter.volume ?? 1);
      vols.set(volume, (vols.get(volume) || 0) + 1);
      const key = branchKey(chapter);
      if (!branches.has(key)) {
        branches.set(key, { id: key, chapters: 0, name: branchLabel(chapter, fallback) });
      }
      branches.get(key).chapters += 1;
    }
    const title = meta.title_ru || meta.title_orig || meta.title_en || id;
    const facts = [
      ["Year", meta.year],
      ["Status", STATUS[meta.status] || labelOf(meta.status)],
      ["Origin", labelOf(meta.type)],
      ["Rating", ratingText(meta.rating, meta.rating_count)],
      ["Views", meta.views_count],
      ["Age", typeof meta.age_rating === "string" || typeof meta.age_rating === "number" ? meta.age_rating : ""],
    ].filter(([, value]) => value != null && value !== "");
    return {
      alt: meta.title_orig && meta.title_orig !== title ? meta.title_orig : meta.title_en || "",
      other: (meta.alt_titles || []).filter((name) => name && name !== title && name !== meta.title_orig),
      summary: summaryHtml(meta.description),
      genres: meta.genres || [],
      tags: meta.tags || [],
      authors: people(meta.author),
      artists: people(meta.artist),
      notes: meta.is_adult ? ["Adult"] : [],
      facts,
      slug: String(meta.id),
      chapters: chapters.length,
      title,
      cover: meta.cover_l800_url || meta.cover_url || "",
      volumes: [...vols.entries()]
        .sort((a, b) => fnum(a[0]) - fnum(b[0]))
        .map(([volume, count]) => ({ v: volume, n: count })),
      branches: [...branches.values()],
    };
  }

  async build(job, data) {
    const id = this.extractId(data.slug);
    const branchId = data.branch;
    const volumes = new Set((data.volumes || []).map((volume) => String(volume)));
    const chapters = (await this.chapters(id))
      .filter((chapter) => volumes.has(String(chapter.volume ?? 1)) && sameBranch(branchKey(chapter), branchId))
      .sort((a, b) => fnum(a.volume) - fnum(b.volume) || fnum(a.number) - fnum(b.number) || fnum(a.id) - fnum(b.id));
    job.total = chapters.length;
    const title = titleWithVolume(data.title, data.volumes);
    const book = new EpubBook();
    book.setIdentifier(`yamiko-${id}-${volumeKey(data.volumes)}`);
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
    await pipeline(
      CHAPTERS,
      chapters,
      async (chapter) => {
        const volume = chapter.volume ?? 1;
        const number = chapter.number;
        const name = chapter.name || "";
        tried += 1;
        const label = `Том ${volume}, глава ${number}`;
        job.msg = label;
        const response = await this.http.get(`${API}/chapters/${chapter.id}/core`, {
          headers: { Referer: `${ORIGIN}/manga/${id}/chapter/${chapter.id}` },
        });
        const payload = response ? response.json() : {};
        const shots = [...(payload.pages || [])].sort((a, b) => fnum(a.order) - fnum(b.order));
        if (!shots.length && chapterLocked(payload)) locked += 1;
        const downloaded = await fetchImages(job, shots, label, (shot) => this.http.get(shot?.url));
        job.done += 1;
        if (this.chapterPause) await sleep(this.chapterPause);
        return {
          volume,
          token: `${String(number).replace(/[\\/:*?"<>|.\s]+/g, "-")}-${chapter.id}`,
          title: `Глава ${number}${name ? `: ${name}` : ""}`,
          downloaded,
        };
      },
      async (ready) => {
        appendPictures(book, pages, groups, counter, css, ready.volume, ready.token, ready.title, ready.downloaded);
      },
    );

    if (!groups.size) {
      if (locked && locked === tried) {
        throw new CoreError("These chapters are locked. Page images are not available for download.", 403);
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

export const CORE = new Yamiko();

import { parse } from "node-html-parser";
import { EpubItem } from "./epub.js";

// Relative units, no forced colours or fonts: readers keep their own theme, font and night mode.
export const CSS = `
body{margin:0;padding:0 .4em;line-height:1.6;hyphens:auto;-webkit-hyphens:auto;orphans:2;widows:2}
.cover{text-align:center;padding-top:10%;page-break-after:always}
.cover img{max-width:78%;max-height:68vh;box-shadow:0 .3em 1em rgba(0,0,0,.4)}
.cover h1{font-size:1.7em;line-height:1.2;margin:1.1em 0 .3em}
.cover p{margin:0;text-indent:0;opacity:.6}
h2.ch{text-align:center;font-size:1.5em;line-height:1.25;margin:3em 0 1.8em;page-break-after:avoid}
h2.ch small{display:block;font-size:.55em;font-weight:normal;letter-spacing:.15em;opacity:.6;margin-bottom:.7em}
h2.ch:after{content:"";display:block;width:3em;margin:1em auto 0;border-top:1px solid;opacity:.4}
.txt p{margin:0;text-align:justify;text-indent:1.4em}
.txt>p:first-child,.txt p.scene+p{text-indent:0}
.txt p.scene{text-align:center;text-indent:0;margin:1.6em 0;letter-spacing:.5em;opacity:.55}
.txt blockquote{margin:1em 1.6em;font-style:italic;opacity:.9}
.txt h1,.txt h2,.txt h3{text-align:center;margin:1.6em 0 .8em;page-break-after:avoid}
.pic{text-align:center;margin:0;padding:0}
.pic img{max-width:100%;max-height:98vh}
`;

const SCENE = /^[*\-–—_=~•#✦◆◇\s]{3,}$/u;
const STRIP_ATTRS = ["style", "class", "id", "width", "height", "align", "srcset"];

export function fnum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function chapterFile(volume, number, part = 0) {
  const vol = String(volume).replaceAll(".", "-");
  const num = String(number).replaceAll(".", "-");
  const base = `v${vol}_c${num}`;
  return part ? `${base}_p${part}.xhtml` : `${base}.xhtml`;
}

export function epubName(title) {
  return `${String(title).replace(/[\\/:*?"<>|]/g, "").trim()}.epub`;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sameBranch(a, b) {
  const norm = (value) => {
    if (value == null || value === "" || value === "null") return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    const text = String(value);
    return /^-?\d+$/.test(text) ? Number(text) : text;
  };
  return norm(a) === norm(b);
}

export function pmHtml(node, att) {
  if (typeof node === "string") return escapeHtml(node);
  if (!node || typeof node !== "object") return "";
  const type = node.type;
  const kids = (node.content || []).map((child) => pmHtml(child, att)).join("");
  if (type === "text") {
    let out = escapeHtml(node.text || "");
    for (const mark of node.marks || []) {
      const tag = { bold: "strong", italic: "em", strike: "s", underline: "u" }[mark?.type];
      if (tag) out = `<${tag}>${out}</${tag}>`;
    }
    return out;
  }
  if (type === "image") {
    const images = node.attrs?.images || [];
    return images
      .filter((image) => att[String(image?.image)])
      .map((image) => `<img src="${att[String(image.image)]}"/>`)
      .join("");
  }
  if (type === "hardBreak") return "<br/>";
  if (type === "horizontalRule") return "<p>***</p>";
  const tags = {
    paragraph: "p",
    blockquote: "blockquote",
    bulletList: "ul",
    orderedList: "ol",
    listItem: "li",
    heading: "h3",
  };
  return Object.prototype.hasOwnProperty.call(tags, type) ? `<${tags[type]}>${kids}</${tags[type]}>` : kids;
}

export function namesOf(list) {
  return (list || []).map((person) => person?.rus_name || person?.name).filter(Boolean);
}

export function mapHit(row) {
  return {
    slug: row.slug_url || row.slug,
    title: row.rus_name || row.name || row.eng_name || "",
    alt: row.eng_name || row.name || "",
    cover: row.cover?.thumbnail || "",
    type: row.type?.label || "",
    year: row.releaseDateString || row.releaseDate || "",
    rating: row.rating?.averageFormated || "",
    status: row.status?.label || "",
  };
}

export function buildInfo(meta, slug, chapters) {
  const vols = new Map();
  const branches = new Map();
  for (const chapter of chapters) {
    const volume = String(chapter.volume);
    vols.set(volume, (vols.get(volume) || 0) + 1);
    for (const branch of chapter.branches || []) {
      const bid = branch.branch_id;
      if (!branches.has(bid)) {
        const team = (branch.teams || [])
          .map((member) => member?.name)
          .filter(Boolean)
          .join(", ");
        branches.set(bid, {
          id: bid == null ? "" : bid,
          chapters: 0,
          name: team || (bid != null ? `Branch ${bid}` : "Default"),
        });
      }
      branches.get(bid).chapters += 1;
    }
  }
  const rating = meta.rating || {};
  const facts = [
    ["Year", meta.releaseDateString || meta.releaseDate],
    ["Status", meta.status?.label],
    ["Translation", meta.scanlateStatus?.label],
    ["Age", meta.ageRestriction?.label],
    [
      "Rating",
      rating.averageFormated
        ? `${rating.averageFormated} (${rating.votesFormated || 0} votes)`
        : null,
    ],
    ["Views", meta.views?.formated],
    ["Origin", meta.type?.label],
    ["Format", (meta.format || []).map((item) => item?.name || "").filter(Boolean).join(", ")],
  ].filter(([, value]) => value);
  const fallback = String(slug || "")
    .split("--")
    .pop()
    .replaceAll("-", " ")
    .replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return {
    alt: meta.eng_name || meta.name || "",
    other: meta.otherNames || [],
    summary: meta.summary ? pmHtml(meta.summary, {}) : "",
    genres: namesOf(meta.genres),
    tags: namesOf(meta.tags),
    authors: namesOf(meta.authors),
    artists: namesOf(meta.artists),
    notes: (meta.content_marking || []).map((note) => note?.label).filter(Boolean),
    facts,
    slug,
    chapters: chapters.length,
    title: meta.rus_name || meta.name || meta.eng_name || fallback,
    cover: meta.cover?.default || "",
    volumes: [...vols.entries()]
      .sort((a, b) => fnum(a[0]) - fnum(b[0]))
      .map(([volume, count]) => ({ v: volume, n: count })),
    branches: [...branches.values()],
  };
}

export function stylesheet() {
  return new EpubItem({ uid: "css", fileName: "style.css", mediaType: "text/css", content: CSS });
}

export function hasText(fragment) {
  return parse(fragment || "").text.trim().length > 0;
}

export function splitMarkers(html) {
  const re = /<!--IMG:(.*?)-->/g;
  const parts = [];
  let last = 0;
  for (const match of String(html).matchAll(re)) {
    parts.push(html.slice(last, match.index));
    parts.push(match[1]);
    last = match.index + match[0].length;
  }
  parts.push(String(html).slice(last));
  return parts;
}

function tagName(el) {
  return String(el?.tagName || el?.rawTagName || "").toLowerCase();
}

function placeMarker(img, name) {
  const token = `\uE000IMG:${name}\uE000`;
  const parent = img.parentNode;
  if (tagName(parent) === "p") parent.insertAdjacentHTML("afterend", token);
  else img.insertAdjacentHTML("afterend", token);
  img.remove();
}

// Downloads illustrations, pulls them out of the prose, and leaves <!--IMG:path--> markers
// so the caller can put each picture on its own page.
export async function tidy(raw, book, counter, fetch) {
  const root = parse(String(raw ?? ""));
  for (const el of root.querySelectorAll("*")) {
    const image = tagName(el) === "img";
    for (const attr of STRIP_ATTRS) {
      if (!image || attr !== "srcset") el.removeAttribute(attr);
    }
  }
  for (const img of [...root.querySelectorAll("img")]) {
    let url = img.getAttribute("src") || img.getAttribute("data-src");
    if (url && url.startsWith("//")) url = `https:${url}`;
    const response = url ? await fetch(url) : null;
    if (!response) {
      img.remove();
      continue;
    }
    const extRaw = String(url).split("?")[0].split(".").pop().toLowerCase();
    const ext = ["jpg", "jpeg", "png", "gif", "webp"].includes(extRaw) ? extRaw : "jpg";
    counter.n += 1;
    const name = `images/img_${counter.n}.${ext}`;
    book.addItem(
      new EpubItem({
        uid: `img${counter.n}`,
        fileName: name,
        mediaType: `image/${ext === "jpg" ? "jpeg" : ext}`,
        content: response.bytes,
      }),
    );
    placeMarker(img, name);
  }
  for (const paragraph of [...root.querySelectorAll("p")]) {
    const text = paragraph.text.trim();
    if (!text && !paragraph.querySelector("img")) paragraph.remove();
    else if (SCENE.test(text)) {
      paragraph.innerHTML = "* * *";
      paragraph.setAttribute("class", "scene");
    }
  }
  return root.toString().replace(/\uE000IMG:(.*?)\uE000/g, "<!--IMG:$1-->");
}

export function titleWithVolume(title, volumes) {
  const list = [...new Set((volumes || []).map((volume) => String(volume)))];
  return list.length === 1 ? `${title} · Том ${list[0]}` : title;
}

export function volumeKey(volumes) {
  return [...new Set((volumes || []).map((volume) => String(volume)))].sort().join("-");
}

export function attachmentMap(attachments, origin) {
  const att = {};
  for (const item of attachments || []) {
    let url = String(item?.url || "");
    if (url.startsWith("/")) url = origin + url;
    for (const key of ["name", "filename", "id"]) {
      const value = item?.[key];
      att[value == null ? "None" : String(value)] = url;
    }
  }
  return att;
}

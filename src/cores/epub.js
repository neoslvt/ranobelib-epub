import { strToU8, zipSync } from "fflate";

const encoder = new TextEncoder();

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bytesOf(content) {
  if (content instanceof Uint8Array) return content;
  return encoder.encode(String(content ?? ""));
}

export class EpubItem {
  constructor({ uid, fileName, mediaType, content }) {
    this.uid = uid;
    this.fileName = fileName;
    this.mediaType = mediaType;
    this.content = content;
  }
}

export class EpubHtml {
  constructor({ title, fileName, lang, content = "" }) {
    this.title = title;
    this.fileName = fileName;
    this.lang = lang || "en";
    this.content = content;
    this.styles = [];
  }

  addItem(item) {
    this.styles.push(item);
  }
}

export class EpubBook {
  constructor() {
    this.identifier = "book";
    this.title = "Book";
    this.language = "en";
    this.items = [];
    this.spine = [];
    this.toc = [];
    this.coverId = null;
  }

  setIdentifier(id) {
    this.identifier = id;
  }

  setTitle(title) {
    this.title = title;
  }

  setLanguage(language) {
    this.language = language;
  }

  addItem(item) {
    this.items.push(item);
    return item;
  }

  setCover(fileName, bytes) {
    const ext = String(fileName).split(".").pop().toLowerCase();
    const media =
      { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] ||
      "image/jpeg";
    const item = new EpubItem({
      uid: "cover-image",
      fileName,
      mediaType: media,
      content: bytes,
    });
    this.coverId = item.uid;
    this.addItem(item);
    return item;
  }
}

function itemId(fileName, used) {
  let id = String(fileName)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/^[A-Za-z_]/.test(id)) id = `id_${id}`;
  const base = id;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function xhtmlDoc({ title, lang, body, cssHrefs }) {
  const links = (cssHrefs || [])
    .map((href) => `<link rel="stylesheet" type="text/css" href="${xml(href)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(lang)}" lang="${xml(lang)}">
<head>
<meta charset="utf-8"/>
<title>${xml(title)}</title>
${links}
</head>
<body>
${body}
</body>
</html>`;
}

function pageRef(page) {
  return { title: page.title || "Chapter", href: page.fileName, children: [] };
}

function normalizeToc(entry) {
  if (entry && Array.isArray(entry.children)) {
    const children = entry.children.filter(Boolean).map(pageRef);
    return { title: entry.title || "Section", href: children[0]?.href || "", children };
  }
  return { ...pageRef(entry), children: [] };
}

function navHtml(nodes) {
  const items = nodes
    .map((node) => {
      const label = node.href
        ? `<a href="${xml(node.href)}">${xml(node.title)}</a>`
        : `<span>${xml(node.title)}</span>`;
      const kids = node.children.length ? navHtml(node.children) : "";
      return `<li>${label}${kids}</li>`;
    })
    .join("");
  return `<ol>${items}</ol>`;
}

function ncxPoints(nodes, state) {
  return nodes
    .map((node) => {
      const id = state.n++;
      const kids = node.children.length ? ncxPoints(node.children, state) : "";
      const src = node.href || node.children[0]?.href || "";
      return `<navPoint id="navPoint-${id}" playOrder="${id}"><navLabel><text>${xml(node.title)}</text></navLabel><content src="${xml(src)}"/>${kids}</navPoint>`;
    })
    .join("");
}

// Returns the EPUB as bytes. The caller (Node server or a future mobile app) writes the file.
export function writeEpub(book) {
  const used = new Set(["nav", "ncx"]);
  const manifest = [];
  const byItem = new Map();

  for (const item of book.items) {
    const id = item.uid && !used.has(item.uid) ? item.uid : itemId(item.fileName, used);
    if (item.uid) used.add(id);
    byItem.set(item, id);
    const cover = id === book.coverId ? ' properties="cover-image"' : "";
    manifest.push(
      `<item id="${xml(id)}" href="${xml(item.fileName)}" media-type="${xml(item.mediaType)}"${cover}/>`,
    );
  }

  const toc = (book.toc || []).filter(Boolean).map(normalizeToc);
  const navBody = `<nav epub:type="toc" id="toc"><h1>Contents</h1>${navHtml(toc)}</nav>`;
  const navDoc = xhtmlDoc({ title: "Contents", lang: book.language, body: navBody, cssHrefs: [] });
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${xml(book.identifier)}"/>
<meta name="dtb:depth" content="${toc.some((n) => n.children.length) ? 2 : 1}"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${xml(book.title)}</text></docTitle>
<navMap>
${ncxPoints(toc, { n: 1 })}
</navMap>
</ncx>`;

  manifest.unshift(
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
  );

  const spine = [];
  for (const entry of book.spine || []) {
    if (entry === "nav") {
      spine.push(`<itemref idref="nav"/>`);
      continue;
    }
    const id = byItem.get(entry);
    if (id) spine.push(`<itemref idref="${xml(id)}"/>`);
  }

  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const coverMeta = book.coverId ? `<meta name="cover" content="${xml(book.coverId)}"/>` : "";
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0" xml:lang="${xml(book.language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="BookId">${xml(book.identifier)}</dc:identifier>
<dc:title>${xml(book.title)}</dc:title>
<dc:language>${xml(book.language)}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
${coverMeta}
</metadata>
<manifest>
${manifest.join("\n")}
</manifest>
<spine toc="ncx">
${spine.join("\n")}
</spine>
</package>`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;

  const files = {};
  // The mimetype entry must be first and stored uncompressed.
  files.mimetype = [strToU8("application/epub+zip"), { level: 0 }];
  files["META-INF/container.xml"] = strToU8(container);
  files["OEBPS/content.opf"] = strToU8(opf);
  files["OEBPS/toc.ncx"] = strToU8(ncx);
  files["OEBPS/nav.xhtml"] = strToU8(navDoc);

  for (const item of book.items) {
    let content = item.content;
    if (item instanceof EpubHtml) {
      const cssHrefs = item.styles.map((style) => style.fileName);
      content = xhtmlDoc({
        title: item.title,
        lang: item.lang || book.language,
        body: item.content,
        cssHrefs,
      });
    }
    files[`OEBPS/${item.fileName}`] = bytesOf(content);
  }

  return zipSync(files);
}

import html
import re
import time

import requests
from ebooklib import epub

from cores.base import Core, CoreError
from cores.kit import chapter_file, epub_name, fnum, retry_get, stylesheet

API = "https://api.cdnlibs.org/api/manga"
INFO_FIELDS = [
    "background", "eng_name", "otherNames", "summary", "releaseDate", "type_id", "caution",
    "views", "close_view", "rate_avg", "rate", "genres", "tags", "teams", "user", "franchise",
    "authors", "publisher", "userRating", "moderated", "metadata", "metadata.count",
    "metadata.close_comments", "translation_quality_rating", "manga_status_id", "chap_count",
    "status_id", "artists", "format",
]


def same_branch(a, b):
    def norm(x):
        if x is None or x == "" or x == "null":
            return None
        if isinstance(x, bool):
            return x
        if isinstance(x, int):
            return x
        text = str(x)
        return int(text) if text.lstrip("-").isdigit() else text
    return norm(a) == norm(b)


def pm_html(n, att):
    if isinstance(n, str):
        return html.escape(n)
    t, kids = n.get("type"), "".join(pm_html(c, att) for c in n.get("content") or [])
    if t == "text":
        out = html.escape(n.get("text", ""))
        for m in n.get("marks") or []:
            tag = {"bold": "strong", "italic": "em", "strike": "s", "underline": "u"}.get(m.get("type"))
            if tag:
                out = f"<{tag}>{out}</{tag}>"
        return out
    if t == "image":
        imgs = (n.get("attrs") or {}).get("images") or []
        return "".join(f'<img src="{att[str(i.get("image"))]}"/>' for i in imgs if att.get(str(i.get("image"))))
    if t == "hardBreak":
        return "<br/>"
    if t == "horizontalRule":
        return "<p>***</p>"
    tags = {"paragraph": "p", "blockquote": "blockquote", "bulletList": "ul", "orderedList": "ol",
            "listItem": "li", "heading": "h3"}
    return f"<{tags[t]}>{kids}</{tags[t]}>" if t in tags else kids


class MangaLib(Core):
    id = "mangalib"
    name = "MangaLib"
    description = "mangalib.me"
    link_re = r"mangalib\.me|\d+--[\w-]+"
    placeholder = "Search by title or paste a link"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "Referer": "https://mangalib.me/",
            "Site-Id": "1",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
            "Client-Time-Zone": "Asia/Almaty",
            "Content-Type": "application/json",
        })
        self.cache = {}
        self._image_root = ""

    def get(self, url, **kw):
        return retry_get(self.session, url, **kw)

    def extract_slug(self, x):
        m = re.search(r"([0-9]+--[a-zA-Z0-9-]+)", x or "")
        return m.group(1) if m else (x or "").strip().strip("/")

    def image_root(self):
        """Page files live on the download server. The main server sends AVIF, which most e-readers cannot open."""
        if self._image_root:
            return self._image_root
        root = "https://img3.cdnlibs.org"
        r = self.get("https://api.cdnlibs.org/api/constants", params={"fields[]": ["imageServers"]})
        servers = ((r.json().get("data") or {}).get("imageServers") or []) if r else []
        for srv in servers:
            if srv.get("id") == "download" and 1 in (srv.get("site_ids") or []) and srv.get("url"):
                root = srv["url"].rstrip("/")
                break
        self._image_root = root
        return root

    def page_url(self, path):
        path = str(path or "")
        if path.startswith("http://") or path.startswith("https://"):
            return path
        if path.startswith("//"):
            path = path[1:]
        if path and not path.startswith("/"):
            path = "/" + path
        return self.image_root() + path

    def chapters(self, slug):
        if slug not in self.cache:
            r = self.get(f"{API}/{slug}/chapters") if slug else None
            chs = r.json().get("data", []) if r else []
            if not chs:
                raise CoreError("Couldn't find chapters. Check the link and try again.", 404)
            self.cache[slug] = chs
        return self.cache[slug]

    def search(self, query):
        q = (query or "").strip()
        r = self.get(API, params={"q": q, "site_id[]": 1, "fields[]": ["rate_avg", "releaseDate"]}) if q else None
        if not r:
            raise CoreError("Search failed. Check your connection and try again.", 502)
        out = []
        for m in r.json().get("data", []):
            out.append(dict(
                slug=m.get("slug_url") or m.get("slug"),
                title=m.get("rus_name") or m.get("name") or m.get("eng_name") or "",
                alt=m.get("eng_name") or m.get("name") or "",
                cover=(m.get("cover") or {}).get("thumbnail", ""),
                type=(m.get("type") or {}).get("label", ""),
                year=m.get("releaseDateString") or m.get("releaseDate") or "",
                rating=(m.get("rating") or {}).get("averageFormated", ""),
                status=(m.get("status") or {}).get("label", "")))
        return out

    def info(self, query):
        slug = self.extract_slug(query)
        chs = self.chapters(slug)
        m = self.get(f"{API}/{slug}", params={"fields[]": INFO_FIELDS})
        meta = (m.json().get("data") or {}) if m else {}
        vols, branches = {}, {}
        for c in chs:
            v = str(c.get("volume"))
            vols[v] = vols.get(v, 0) + 1
            for b in c.get("branches", []):
                bid = b.get("branch_id")
                team = ", ".join(t.get("name", "") for t in b.get("teams", []) if t.get("name"))
                e = branches.setdefault(bid, {
                    "id": "" if bid is None else bid, "chapters": 0,
                    "name": team or (f"Branch {bid}" if bid is not None else "Default")})
                e["chapters"] += 1
        names = lambda L: [p.get("rus_name") or p.get("name") for p in L or [] if p.get("rus_name") or p.get("name")]
        rt = meta.get("rating") or {}
        facts = [[k, v] for k, v in [
            ("Year", meta.get("releaseDateString") or meta.get("releaseDate")),
            ("Status", (meta.get("status") or {}).get("label")),
            ("Translation", (meta.get("scanlateStatus") or {}).get("label")),
            ("Age", (meta.get("ageRestriction") or {}).get("label")),
            ("Rating", f"{rt['averageFormated']} ({rt.get('votesFormated', 0)} votes)" if rt.get("averageFormated") else None),
            ("Views", (meta.get("views") or {}).get("formated")),
            ("Origin", (meta.get("type") or {}).get("label")),
            ("Format", ", ".join(f.get("name", "") for f in meta.get("format") or [])),
        ] if v]
        return dict(
            alt=meta.get("eng_name") or meta.get("name") or "", other=meta.get("otherNames") or [],
            summary=pm_html(meta["summary"], {}) if meta.get("summary") else "",
            genres=names(meta.get("genres")), tags=names(meta.get("tags")),
            authors=names(meta.get("authors")), artists=names(meta.get("artists")),
            notes=[c.get("label") for c in meta.get("content_marking") or [] if c.get("label")], facts=facts,
            slug=slug, chapters=len(chs),
            title=meta.get("rus_name") or meta.get("name") or meta.get("eng_name") or slug.split("--")[-1].replace("-", " ").title(),
            cover=(meta.get("cover") or {}).get("default", ""),
            volumes=[{"v": v, "n": n} for v, n in sorted(vols.items(), key=lambda x: fnum(x[0]))],
            branches=list(branches.values()))

    def build(self, job, data, out_dir):
        slug, bid = data["slug"], data.get("branch")
        vols = {str(v) for v in data["volumes"]}
        chs = sorted((c for c in self.chapters(slug) if str(c.get("volume")) in vols),
                     key=lambda c: (fnum(c.get("volume")), fnum(c.get("number"))))
        job["total"] = len(chs)
        title = data["title"] + (f" · Том {next(iter(vols))}" if len(vols) == 1 else "")
        book = epub.EpubBook()
        book.set_identifier(f"manga-{slug}-{'-'.join(sorted(vols))}")
        book.set_title(title)
        book.set_language("ru")
        css = stylesheet()
        book.add_item(css)

        cover = ""
        if data.get("cover"):
            r = self.get(data["cover"])
            if r:
                book.set_cover("cover.jpg", r.content, create_page=False)
                cover = '<img src="cover.jpg" alt=""/>'
        tp = epub.EpubHtml(title="Обложка", file_name="title.xhtml", lang="ru")
        tp.content = f'''<div class="cover">{cover}
            <h1>{html.escape(title)}</h1>
            <p><a href="https://github.com/neoslvt/ranobelib-epub">ranobelib-epub by Neoslvt</a></p>
            <p>Translated by {html.escape(data["team"])}</p>
        </div>'''
        tp.add_item(css)
        book.add_item(tp)

        groups, pages, n = {}, [], [0]
        for c in chs:
            v, num, name = c.get("volume"), c.get("number"), c.get("name") or ""
            bs = c.get("branches", [])
            if not bs:
                continue
            b = next((b for b in bs if same_branch(b.get("branch_id"), bid)), bs[0])
            job["msg"] = f"Том {v}, глава {num}"
            r = self.get(f"{API}/{slug}/chapter", params={"volume": v, "number": num, "branch_id": b.get("branch_id")})
            payload = (r.json().get("data") or {}) if r else {}
            shots = sorted(payload.get("pages") or [], key=lambda p: fnum(p.get("slug")))
            job["done"] += 1
            ch_title = f"Глава {num}" + (f": {name}" if name else "")
            first = None
            for i, shot in enumerate(shots):
                img = self.get(self.page_url(shot.get("url")))
                ctype = ((img.headers.get("content-type") or "").split(";")[0].strip().lower() if img else "")
                if not img or not ctype.startswith("image/"):
                    continue
                ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}.get(ctype, "jpg")
                n[0] += 1
                fname = f"images/img_{n[0]}.{ext}"
                book.add_item(epub.EpubItem(uid=f"img{n[0]}", file_name=fname,
                              media_type="image/" + ("jpeg" if ext == "jpg" else ext), content=img.content))
                pg = epub.EpubHtml(title=ch_title if not i else "Страница", file_name=chapter_file(v, num, i), lang="ru")
                pg.content = f'<div class="pic"><img src="{fname}" alt=""/></div>'
                pg.add_item(css)
                book.add_item(pg)
                pages.append(pg)
                if first is None:
                    first = pg
            if first is not None:
                groups.setdefault(v, []).append(first)
            time.sleep(0.3)

        if not groups:
            raise RuntimeError("No chapter pages could be retrieved.")
        starts = [c for g in groups.values() for c in g]
        book.toc = [(epub.Section(f"Том {v}"), g) for v, g in groups.items()] if len(groups) > 1 else starts
        book.add_item(epub.EpubNcx())
        book.add_item(epub.EpubNav())
        book.spine = [tp, "nav"] + pages
        fname = epub_name(title)
        epub.write_epub(str(out_dir / fname), book, {})
        return fname


CORE = MangaLib()

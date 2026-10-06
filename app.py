import html, os, re, socket, sys, threading, time, uuid, webbrowser
from pathlib import Path
import requests
from bs4 import BeautifulSoup, Comment
from ebooklib import epub
from flask import Flask, jsonify, request, send_file, send_from_directory

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
OUT = Path.home() / "RanobeLibrary"
OUT.mkdir(exist_ok=True)
API = "https://api.cdnlibs.org/api/manga"

s = requests.Session()
s.headers.update({
    'Referer': 'https://ranobelib.me/', 'Site-Id': '3',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    'Client-Time-Zone': 'Asia/Almaty',
})
# index.html can sit in ./static/ or right next to app.py
STATIC = next((p for p in (BASE / "static", BASE) if (p / "index.html").exists()), BASE)
app = Flask(__name__, static_folder=None)
CACHE, JOBS = {}, {}

# Relative units, no forced colours or fonts: readers keep their own theme, font and night mode.
CSS = """
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
"""


def get(url, **kw):
    for i in range(3):
        try:
            r = s.get(url, timeout=20, **kw)
            if r.status_code == 200:
                return r
        except requests.RequestException:
            pass
        time.sleep(1 + i)


def extract_slug(x):
    m = re.search(r'([0-9]+--[a-zA-Z0-9-]+)', x)
    return m.group(1) if m else x.strip().strip('/')


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def tidy(raw, book, n):
    """Strip site styling, embed images on their own pages, normalise scene breaks."""
    soup = BeautifulSoup(raw, 'html.parser')
    for t in soup.find_all(True):
        for a in ("style", "class", "id", "width", "height", "align", "srcset"):
            if t.name != "img" or a not in ("srcset",):
                t.attrs.pop(a, None)
    for img in soup.find_all('img'):
        url = img.get('src') or img.get('data-src')
        r = get('https:' + url if url and url.startswith('//') else url) if url else None
        if not r:
            img.decompose()
            continue
        ext = url.split('?')[0].rsplit('.', 1)[-1].lower()
        ext = ext if ext in ('jpg', 'jpeg', 'png', 'gif', 'webp') else 'jpg'
        n[0] += 1
        name = f"images/img_{n[0]}.{ext}"
        book.add_item(epub.EpubItem(uid=f"img{n[0]}", file_name=name,
                      media_type="image/" + ("jpeg" if ext == "jpg" else ext), content=r.content))
        marker = Comment(f"IMG:{name}")  # build() splits the chapter here
        p = img.find_parent("p")
        if p:
            p.insert_after(marker)
            img.decompose()
        else:
            img.replace_with(marker)
    for p in soup.find_all("p"):
        txt = p.get_text(strip=True)
        if not txt and not p.find("img"):
            p.decompose()
        elif re.fullmatch(r"[*\-–—_=~•#✦◆◇\s]{3,}", txt):
            p.string = "* * *"
            p["class"] = "scene"
    return str(soup)


def build(jid, d):
    j = JOBS[jid]
    try:
        slug, bid, vols = d["slug"], int(d["branch"]), set(d["volumes"])
        chs = sorted((c for c in CACHE[slug] if str(c.get("volume")) in vols),
                     key=lambda c: (fnum(c.get("volume")), fnum(c.get("number"))))
        j["total"] = len(chs)
        title = d["title"] + (f" · Том {next(iter(vols))}" if len(vols) == 1 else "")
        book = epub.EpubBook()
        book.set_identifier(f"ranobe-{slug}-{'-'.join(sorted(vols))}")
        book.set_title(title)
        book.set_language('ru')
        css = epub.EpubItem(uid="css", file_name="style.css", media_type="text/css", content=CSS)
        book.add_item(css)

        cover = ""
        if d.get("cover"):
            r = get(d["cover"])
            if r:
                book.set_cover("cover.jpg", r.content, create_page=False)
                cover = '<img src="cover.jpg" alt=""/>'
        tp = epub.EpubHtml(title="Обложка", file_name="title.xhtml", lang='ru')
        tp.content = f'''<div class="cover">{cover}
            <h1>{html.escape(title)}</h1>
            <p>Downloaded from the ranobelib.me using <a href="https://github.com/neoslvt/ranobelib-epub">ranobelib-epub by Neoslvt</a></p>
            <p>Translated by {html.escape(d["team"])}</p>
        </div>'''

        tp.add_item(css)
        book.add_item(tp)

        groups, pages, n = {}, [], [0]
        for c in chs:
            v, num, name = c.get("volume"), c.get("number"), c.get("name") or ""
            bs = c.get("branches", [])
            if not bs:
                continue
            b = next((b for b in bs if b.get("branch_id") == bid), bs[0])
            j["msg"] = f"глава {num}"
            r = get(f"{API}/{slug}/chapter", params={'volume': v, 'number': num, 'branch_id': b.get("branch_id")})
            content = (r.json().get("data") or {}).get("content") if r else None
            j["done"] += 1
            if not content:
                continue
            sub = f"<br/>{html.escape(name)}" if name else ""
            head = f'<h2 class="ch">Глава {num}{sub}</h2>'
            tag = f"v{v}_c{str(num).replace('.', '_')}"
            ch_title = f"Глава {num}" + (f": {name}" if name else "")
            parts = re.split(r"<!--IMG:(.*?)-->", tidy(content, book, n))  # text, image, text, image, ...
            first = None
            for i, part in enumerate(parts):
                if i % 2:  # every illustration gets its own file, so it is always alone on its page
                    pg = epub.EpubHtml(title="Иллюстрация", file_name=f"{tag}_{i}.xhtml", lang='ru')
                    pg.content = f'<div class="pic"><img src="{part}" alt=""/></div>'
                else:
                    frag = BeautifulSoup(part, 'html.parser')
                    if i and not frag.get_text(strip=True):
                        continue
                    pg = epub.EpubHtml(title=ch_title, file_name=f"{tag}_{i}.xhtml" if i else f"{tag}.xhtml", lang='ru')
                    pg.content = (head if not i else "") + f'<div class="txt">{frag}</div>'
                pg.add_item(css)
                book.add_item(pg)
                pages.append(pg)
                if not i:
                    first = pg
            groups.setdefault(v, []).append(first)
            time.sleep(0.5)

        if not groups:
            raise RuntimeError("No chapter text could be retrieved.")
        starts = [c for g in groups.values() for c in g]
        book.toc = [(epub.Section(f"Том {v}"), g) for v, g in groups.items()] if len(groups) > 1 else starts
        book.add_item(epub.EpubNcx())
        book.add_item(epub.EpubNav())
        book.spine = [tp, 'nav'] + pages
        fname = re.sub(r'[\\/:*?"<>|]', '', title).strip() + ".epub"
        epub.write_epub(str(OUT / fname), book, {})
        j.update(state="done", file=fname, msg="Ready")
    except Exception as e:
        j.update(state="error", msg=str(e))


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/api/info")
def info():
    slug = extract_slug(request.args.get("q", ""))
    r = get(f"{API}/{slug}/chapters") if slug else None
    chs = r.json().get("data", []) if r else []
    if not chs:
        return jsonify(error="Couldn't find chapters. Check the link and try again."), 404
    CACHE[slug] = chs
    m = get(f"{API}/{slug}")
    meta = (m.json().get("data") or {}) if m else {}
    vols, branches = {}, {}
    for c in chs:
        v = str(c.get("volume"))
        vols[v] = vols.get(v, 0) + 1
        for b in c.get("branches", []):
            e = branches.setdefault(b.get("branch_id"), {
                "id": b.get("branch_id"), "chapters": 0,
                "name": ", ".join(t.get("name", "") for t in b.get("teams", []) if t.get("name")) or f"Branch {b.get('branch_id')}"})
            e["chapters"] += 1
    return jsonify(
        slug=slug, chapters=len(chs),
        title=meta.get("rus_name") or meta.get("name") or meta.get("eng_name") or slug.split("--")[-1].replace("-", " ").title(),
        cover=(meta.get("cover") or {}).get("default", ""),
        volumes=[{"v": v, "n": n} for v, n in sorted(vols.items(), key=lambda x: fnum(x[0]))],
        branches=list(branches.values()))


@app.post("/api/start")
def start():
    jid = uuid.uuid4().hex[:8]
    JOBS[jid] = {"done": 0, "total": 0, "state": "running", "msg": "Starting…", "file": None}
    threading.Thread(target=build, args=(jid, request.json), daemon=True).start()
    return jsonify(id=jid)


@app.get("/api/progress/<jid>")
def progress(jid):
    return jsonify(JOBS.get(jid, {"state": "error", "msg": "Unknown job"}))


@app.get("/api/library")
def library():
    fs = sorted(OUT.glob("*.epub"), key=lambda f: f.stat().st_mtime, reverse=True)
    return jsonify([{"name": f.name, "mb": round(f.stat().st_size / 1e6, 1)} for f in fs])


@app.get("/api/file/<name>")
def file(name):
    return send_file(OUT / Path(name).name, as_attachment=True)


@app.post("/api/quit")
def quit_app():
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return jsonify(ok=True)


if __name__ == "__main__":
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    print(f"Books are saved to {OUT}")
    threading.Thread(target=lambda: app.run("127.0.0.1", port), daemon=True).start()
    try:
        import webview
    except ImportError:
        print("pywebview is not installed, opening in the browser instead.")
        webbrowser.open(url)
        threading.Event().wait()
    else:
        getattr(webview, "settings", {})["ALLOW_DOWNLOADS"] = True  # lets the window save EPUBs
        webview.create_window("Ranobe to EPUB", url, width=920, height=860, min_size=(520, 600))
        webview.start()  # closing the window ends the app

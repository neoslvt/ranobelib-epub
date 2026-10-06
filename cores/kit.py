import re
import time

import requests
from bs4 import BeautifulSoup, Comment
from ebooklib import epub

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


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def chapter_file(volume, number, part=0):
    vol = str(volume).replace(".", "-")
    num = str(number).replace(".", "-")
    base = f"v{vol}_c{num}"
    return f"{base}.xhtml" if not part else f"{base}_p{part}.xhtml"


def epub_name(title):
    return re.sub(r'[\\/:*?"<>|]', "", title).strip() + ".epub"


def retry_get(session, url, **kw):
    for i in range(3):
        try:
            r = session.get(url, timeout=20, **kw)
            if r.status_code == 200:
                return r
        except requests.RequestException:
            pass
        time.sleep(1 + i)


def tidy(raw, book, n, fetch):
    soup = BeautifulSoup(raw, "html.parser")
    for t in soup.find_all(True):
        for a in ("style", "class", "id", "width", "height", "align", "srcset"):
            if t.name != "img" or a not in ("srcset",):
                t.attrs.pop(a, None)
    for img in soup.find_all("img"):
        url = img.get("src") or img.get("data-src")
        r = fetch("https:" + url if url and url.startswith("//") else url) if url else None
        if not r:
            img.decompose()
            continue
        ext = url.split("?")[0].rsplit(".", 1)[-1].lower()
        ext = ext if ext in ("jpg", "jpeg", "png", "gif", "webp") else "jpg"
        n[0] += 1
        name = f"images/img_{n[0]}.{ext}"
        book.add_item(epub.EpubItem(uid=f"img{n[0]}", file_name=name,
                      media_type="image/" + ("jpeg" if ext == "jpg" else ext), content=r.content))
        marker = Comment(f"IMG:{name}")  # the core splits the chapter here
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


def stylesheet():
    return epub.EpubItem(uid="css", file_name="style.css", media_type="text/css", content=CSS)

import html
import os
import socket
import sys
import threading
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory

import cores
from cores.base import CoreError

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
OUT = Path.home() / "RanobeLibrary"
OUT.mkdir(exist_ok=True)
# index.html can sit in ./static/ or right next to app.py
STATIC = next((p for p in (BASE / "static", BASE) if (p / "index.html").exists()), BASE)
app = Flask(__name__, static_folder=None)
JOBS = {}


def _run(jid, core, data):
    j = JOBS[jid]
    try:
        j["file"] = core.build(j, data, OUT)
        j.update(state="done", msg="Ready")
    except Exception as e:
        j.update(state="error", msg=str(e))


def _core_options():
    parts = []
    for core in cores.all_cores():
        meta = core.public()
        parts.append(
            '<option value="{id}" data-link="{link}" data-placeholder="{placeholder}">{name}</option>'.format(
                id=html.escape(meta["id"], quote=True),
                link=html.escape(meta["link"] or "", quote=True),
                placeholder=html.escape(meta["placeholder"] or "", quote=True),
                name=html.escape(meta["name"]),
            )
        )
    return "".join(parts)


@app.get("/")
def index():
    page = (STATIC / "index.html").read_text(encoding="utf-8")
    page = page.replace("<!--CORES-->", _core_options())
    return page, {"Cache-Control": "no-store"}


@app.get("/api/cores")
def core_list():
    return jsonify([c.public() for c in cores.all_cores()])


@app.get("/api/match")
def match():
    core = cores.match(request.args.get("q", ""))
    return jsonify(core=core.id if core else None)


@app.get("/api/info")
def info():
    try:
        core_id = request.args.get("core")
        core = cores.get(core_id) if core_id else cores.match(request.args.get("q", ""))
        if core is None:
            raise CoreError("No source recognized that link.", 404)
        payload = core.info(request.args.get("q", ""))
        payload["core"] = core.id
        return jsonify(payload)
    except CoreError as e:
        return jsonify(error=str(e)), e.status


@app.get("/api/search")
def search_books():
    try:
        core = cores.get(request.args.get("core"))
        hits = core.search(request.args.get("q", "")) or []
    except CoreError as e:
        return jsonify(error=str(e)), e.status
    return jsonify([dict(hit, core=core.id, source=core.name) for hit in hits])


@app.post("/api/start")
def start():
    data = request.get_json(silent=True) or {}
    try:
        core = cores.get(data.get("core"))
    except CoreError as e:
        return jsonify(error=str(e)), e.status
    jid = uuid.uuid4().hex[:8]
    JOBS[jid] = {"done": 0, "total": 0, "state": "running", "msg": "Starting…", "file": None}
    threading.Thread(target=_run, args=(jid, core, data), daemon=True).start()
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


def open_window(url):
    # On KDE, pywebview tries Qt first. PyQt without Qt WebEngine should fall through to GTK.
    if sys.platform.startswith("linux") and not os.environ.get("PYWEBVIEW_GUI"):
        try:
            import qtpy.QtWebEngineCore  # noqa: F401
        except Exception:
            os.environ["PYWEBVIEW_GUI"] = "gtk"
    try:
        import webview
    except ImportError:
        print("pywebview is not installed, opening in the browser instead.")
        webbrowser.open(url)
        threading.Event().wait()
        return
    try:
        getattr(webview, "settings", {})["ALLOW_DOWNLOADS"] = True  # lets the window save EPUBs
        webview.create_window("Ranobe to EPUB", url, width=920, height=860, min_size=(520, 600))
        webview.start()  # closing the window ends the app
    except Exception as e:
        print(f"The desktop window could not be opened ({e}). Opening in the browser instead.")
        webbrowser.open(url)
        threading.Event().wait()


if __name__ == "__main__":
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    names = ", ".join(c.name for c in cores.all_cores()) or "none"
    print(f"Sources: {names}")
    print(f"Books are saved to {OUT}")
    threading.Thread(target=lambda: app.run("127.0.0.1", port), daemon=True).start()
    open_window(url)

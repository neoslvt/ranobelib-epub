import importlib.util
import re
import sys
import threading
from pathlib import Path

from cores.base import Core, CoreError
from cores.ranobelib import CORE as _ranobelib

_BUILTINS = [_ranobelib]
_SKIP = {"__init__.py", "base.py", "kit.py"}
_scanned = {}  # filename -> (mtime, Core or None)
_lock = threading.RLock()


def _dirs():
    here = Path(__file__).resolve().parent
    root = here.parent
    found = []
    for folder in (here, root / "CORES", root / "cores"):
        if folder.is_dir() and folder not in found:
            found.append(folder)
    if getattr(sys, "frozen", False):
        extra = Path(sys.executable).resolve().parent / "cores"
        if extra.is_dir() and extra not in found:
            found.append(extra)
    return found


def _load_file(path):
    mod_name = f"cores._dyn_{path.stem}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if not spec or not spec.loader:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    obj = getattr(mod, "CORE", None)
    if isinstance(obj, type) and issubclass(obj, Core) and obj is not Core:
        obj = obj()
    if not isinstance(obj, Core):
        print(f"Skipping {path.name}: define CORE = YourCore()", file=sys.stderr)
        return None
    if not obj.id:
        obj.id = path.stem
    if not obj.name:
        obj.name = obj.id
    return obj


def refresh():
    with _lock:
        _refresh()


def _refresh():
    seen = set()
    for folder in _dirs():
        for path in sorted(folder.glob("*.py")):
            if path.name.startswith("_") or path.name in _SKIP:
                continue
            seen.add(path.name)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            prev = _scanned.get(path.name)
            if prev and prev[0] == mtime:
                continue
            try:
                core = _load_file(path)
            except Exception as e:
                print(f"Skipping core {path.name}: {e}", file=sys.stderr)
                _scanned[path.name] = (mtime, None)
                continue
            _scanned[path.name] = (mtime, core)
    for name in list(_scanned):
        if name not in seen:
            del _scanned[name]


def all_cores():
    with _lock:
        _refresh()
        scanned = [item[1] for item in _scanned.values() if item[1]]
    # Files in the cores folder win, so a dropped-in core is what the menu shows.
    # The imported copy is only there when that file is not on disk (a frozen build).
    scanned_ids = {core.id for core in scanned}
    out, seen = [], set()
    for core in [c for c in _BUILTINS if c.id not in scanned_ids] + scanned:
        if core.id in seen:
            print(f"Skipping duplicate core id {core.id!r}", file=sys.stderr)
            continue
        seen.add(core.id)
        out.append(core)
    return out


def get(core_id):
    items = all_cores()
    if not items:
        raise CoreError("No sources are installed.", 500)
    if not core_id:
        return items[0]
    for core in items:
        if core.id == core_id:
            return core
    raise CoreError("Unknown source.", 404)


def match(query):
    query = query or ""
    found = []
    for core in all_cores():
        pattern = core.link_re or ""
        if not pattern:
            continue
        try:
            ok = re.search(pattern, query)
        except re.error:
            print(f"Ignoring invalid link pattern on {core.id}", file=sys.stderr)
            continue
        if ok:
            found.append(core)
    if not found:
        return None
    found.sort(key=lambda c: len(c.link_re), reverse=True)
    return found[0]

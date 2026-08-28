#!/usr/bin/env python3
"""Web UI extensions on top of limits: safe host directory browser."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import server_ext as ext


def _project_roots() -> tuple[Path, ...]:
    raw = ext.base.setting("OPENCODE_PROJECT_ROOTS", "~") or "~"
    roots: list[Path] = []
    for item in raw.split(";"):
        value = item.strip()
        if not value:
            continue
        try:
            candidate = Path(value).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if candidate.is_dir() and candidate not in roots:
            roots.append(candidate)
    return tuple(roots)


def _inside(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents


def _allowed(candidate: Path, roots: tuple[Path, ...]) -> bool:
    return any(_inside(candidate, root) for root in roots)


def directory_snapshot(raw_path: str | None = None) -> dict[str, object]:
    roots = _project_roots()
    root_rows = [{"name": root.name or str(root), "path": str(root)} for root in roots]
    if not raw_path:
        return {"roots": root_rows, "current": None, "parent": None, "directories": []}

    try:
        current = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return {"error": "directory-not-found", "roots": root_rows}
    if not current.is_dir() or not _allowed(current, roots):
        return {"error": "directory-outside-allowed-roots", "roots": root_rows}

    parent = current.parent.resolve(strict=False)
    parent_value = str(parent) if parent != current and _allowed(parent, roots) else None
    directories: list[dict[str, str]] = []
    try:
        children = sorted(current.iterdir(), key=lambda path: path.name.casefold())
    except OSError:
        children = []
    for child in children:
        if child.name.startswith("."):
            continue
        try:
            resolved = child.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if not resolved.is_dir() or not _allowed(resolved, roots):
            continue
        directories.append({"name": child.name, "path": str(resolved)})
        if len(directories) >= 250:
            break

    return {
        "roots": root_rows,
        "current": str(current),
        "name": current.name or str(current),
        "parent": parent_value,
        "directories": directories,
    }


class Handler(ext.Handler):
    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/client-directories.json":
            if not self.authenticated():
                return
            params = parse_qs(parsed.query)
            raw_path = (params.get("path") or [None])[0]
            self.json_response(directory_snapshot(raw_path))
            return
        super().do_GET()


def main() -> None:
    ext.base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = ext.base.ThreadingHTTPServer((ext.base.WEB_HOST, ext.base.WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {ext.base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

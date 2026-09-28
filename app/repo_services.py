#!/usr/bin/env python3
"""Repository index, context cache, artifacts and verification helpers."""
from __future__ import annotations
import base64
import ctypes
import gzip

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Any, Iterable
from uuid import uuid4
import zlib

from runtime_store import RuntimeStore, now_ms

TEXT_EXTENSIONS = {
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".kt",
    ".kts",
    ".go",
    ".rs",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".sh",
    ".bash",
    ".md",
    ".toml",
    ".yaml",
    ".yml",
    ".json",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".sql",
}
DEPENDENCY_FILES = {
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "requirements.txt",
    "poetry.lock",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "AGENTS.md",
}
SYMBOL_PATTERNS = [
    re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(", re.M),
    re.compile(r"^\s*class\s+([A-Za-z_][\w]*)\b", re.M),
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M),
    re.compile(
        r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^\n]*=>",
        re.M,
    ),
    re.compile(r"^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(", re.M),
    re.compile(
        r"^\s*(?:public\s+|private\s+|protected\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_][\w]*)\b",
        re.M,
    ),
]


def _run(
    root: Path, args: list[str], timeout: float = 12.0, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(root),
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )


def safe_repo_file(root: Path, relative: str) -> Path | None:
    """Return a regular file physically contained by root; reject symlink escapes."""
    try:
        candidate = root / relative
        if candidate.is_symlink():
            return None
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
        return resolved if resolved.is_file() else None
    except (OSError, ValueError, RuntimeError):
        return None


_GIT_SNAPSHOT_LOCK = threading.Lock()
_GIT_SNAPSHOT_CACHE: dict[str, tuple[float, tuple[Any, ...], dict[str, Any]]] = {}
_GIT_REFRESHING: set[str] = set()
_GIT_REFRESH_RETRY_AT: dict[str, float] = {}
_GIT_GENERATION: dict[str, int] = {}
# Roots whose snapshot was invalidated by a tool write: the last snapshot keeps
# being served (stale) while a background refresh replaces it.
_GIT_INVALIDATED: set[str] = set()
# Roots where `git diff-files` cannot meet its validation budget (9P): a
# fork+kill per cache hit validated nothing, so skip it for a while.
_GIT_VALIDATOR_SLOW_UNTIL: dict[str, float] = {}
_GIT_VALIDATOR_BACKOFF_SECONDS = 600.0
_SLOW_FS: dict[str, bool] = {}
_V9FS_MAGIC = 0x01021997  # WSL2 drvfs (/mnt/<drive>) is served over 9P
_GIT_TOPLEVEL: dict[str, tuple[float, str | None]] = {}
_GIT_VALIDATED_AT: dict[str, float] = {}


def _statfs_type(path: str) -> int | None:
    if not sys.platform.startswith("linux"):
        return None
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        buffer = ctypes.create_string_buffer(512)  # struct statfs is < 128 bytes
        if libc.statfs(os.fsencode(path), buffer) != 0:
            return None
        width = ctypes.sizeof(ctypes.c_long)  # f_type is the leading __fsword_t
        return int.from_bytes(buffer.raw[:width], sys.byteorder, signed=False) & 0xFFFFFFFF
    except (OSError, AttributeError, ValueError, TypeError):
        return None


def slow_filesystem(root: Path) -> bool:
    """True for 9P/drvfs trees (WSL /mnt/<drive>), where every git call is slow."""
    key = str(root)
    cached = _SLOW_FS.get(key)
    if cached is None:
        cached = key == "/mnt" or key.startswith("/mnt/") or _statfs_type(key) == _V9FS_MAGIC
        _SLOW_FS[key] = cached
    return cached


def _git_snapshot_ttl(root: Path | None = None) -> float:
    configured = os.environ.get("OPENCODE_GIT_SNAPSHOT_TTL_SECONDS")
    if configured:
        try:
            return max(0.05, float(configured))
        except ValueError:
            pass
    if root is not None and slow_filesystem(root):
        # `git status` alone costs ~0.65 s on /mnt/c: refresh far less often.
        try:
            return max(0.05, float(os.environ.get("OPENCODE_GIT_SNAPSHOT_SLOW_FS_TTL_SECONDS") or 20.0))
        except ValueError:
            return 20.0
    return 1.5


def _snapshot_copy(value: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {**value, **extra}


def _repo_quick_stamp(root: Path) -> tuple[Any, ...]:
    """Cheap invalidation for structural/index changes without invoking Git."""
    values: list[Any] = []
    for path in (root, root / ".git", root / ".git" / "index", root / ".git" / "HEAD"):
        try:
            st = path.stat()
            values.extend((st.st_mtime_ns, st.st_size))
        except OSError:
            values.extend((None, None))
    return tuple(values)


def _stamp_digest(value: tuple[Any, ...]) -> str:
    return hashlib.sha256(repr(value).encode()).hexdigest()[:16]


def _worktree_stamp(root: Path) -> str:
    """Root directory + HEAD only. `git status` refreshes .git/index (and so
    treeStamp) without any content change; this stamp ignores that."""
    values: list[Any] = []
    for path in (root, root / ".git" / "HEAD"):
        try:
            st = path.stat()
            values.extend((st.st_mtime_ns, st.st_size))
        except OSError:
            values.extend((None, None))
    return _stamp_digest(tuple(values))


def _changed_stat_stamp(root: Path, changed: Iterable[str]) -> str:
    """Cheaply detect edits to files already known dirty in the cached snapshot."""
    digest = hashlib.sha256()
    for relative in sorted(dict.fromkeys(str(item) for item in changed if item)):
        digest.update(relative.encode("utf-8", errors="surrogateescape"))
        item = Path(relative)
        if item.is_absolute() or ".." in item.parts:
            digest.update(b"\0missing")
            continue
        try:
            # Metadata only: resolving every dirty path costs a syscall chain on WSL/NTFS.
            details = (root / item).lstat()
            digest.update(
                f"\0{details.st_size}:{details.st_mtime_ns}:{details.st_ctime_ns}".encode()
            )
        except OSError:
            digest.update(b"\0unreadable")
    return digest.hexdigest()[:16]


def _cached_snapshot_valid(root: Path, snapshot: dict[str, Any]) -> bool:
    if snapshot.get("changedStamp") != _changed_stat_stamp(root, snapshot.get("changed") or []):
        return False
    if not snapshot.get("git"):
        return True
    key = str(root)
    if time.monotonic() < _GIT_VALIDATOR_SLOW_UNTIL.get(key, 0.0):
        # Known to exceed its budget here; rely on the TTL refresh and on tool
        # writes invalidating the snapshot.
        return True
    try:
        validate_ms = max(
            5.0,
            min(200.0, float(os.environ.get("OPENCODE_GIT_CACHE_VALIDATE_MS", "40"))),
        )
    except ValueError:
        validate_ms = 40.0
    try:
        proc = _run(
            root,
            ["git", "diff-files", "--name-only", "-z", "--ignore-submodules", "--"],
            timeout=validate_ms / 1000.0,
        )
    except subprocess.TimeoutExpired:
        # On very large/slow filesystems the validator must never become the
        # new hot-path stall. Tool writes explicitly invalidate the cache and a
        # full refresh is already scheduled in the background.
        _GIT_VALIDATOR_SLOW_UNTIL[key] = time.monotonic() + _GIT_VALIDATOR_BACKOFF_SECONDS
        return True
    if proc.returncode != 0:
        return True
    working_tree_dirty = {item for item in proc.stdout.split("\0") if item}
    known = set(snapshot.get("changed") or [])
    return working_tree_dirty.issubset(known)


def _cached_snapshot_ok(root: Path, key: str, captured_at: float, snapshot: dict[str, Any]) -> bool:
    """_cached_snapshot_valid, throttled on 9P where each dirty-file lstat costs
    ~1 ms (110 dirty files = 110 ms per cache hit). A capture counts as a
    validation; tool writes still invalidate immediately."""
    if slow_filesystem(root):
        try:
            interval = float(os.environ.get("OPENCODE_GIT_SLOW_FS_VALIDATE_SECONDS") or 5.0)
        except ValueError:
            interval = 5.0
        if time.monotonic() - max(captured_at, _GIT_VALIDATED_AT.get(key, 0.0)) < interval:
            return True
    valid = _cached_snapshot_valid(root, snapshot)
    if valid:
        _GIT_VALIDATED_AT[key] = time.monotonic()
    return valid


def _capture_git_snapshot(root: Path, *, include_untracked: bool, timeout: float) -> dict[str, Any]:
    """Capture repository state without letting Git latency abort an interactive request."""
    try:
        probe = _run(root, ["git", "rev-parse", "--is-inside-work-tree"], timeout=min(1.5, timeout))
    except subprocess.TimeoutExpired:
        return {
            "git": (root / ".git").exists(),
            "head": None,
            "status": [],
            "changed": [],
            "statusHash": "timeout",
            "trackedHash": None,
            "untrackedHash": None,
            "changedStamp": _changed_stat_stamp(root, []),
            "treeStamp": _stamp_digest(_repo_quick_stamp(root)),
            "worktreeStamp": _worktree_stamp(root),
            "partial": True,
            "includesUntracked": False,
            "capturedAt": now_ms(),
        }
    if probe.returncode != 0:
        return {
            "git": False,
            "head": None,
            "status": [],
            "changed": [],
            "statusHash": "nogit",
            "trackedHash": "nogit",
            "untrackedHash": None,
            "changedStamp": _changed_stat_stamp(root, []),
            "treeStamp": _stamp_digest(_repo_quick_stamp(root)),
            "worktreeStamp": _worktree_stamp(root),
            "partial": False,
            "includesUntracked": False,
            "capturedAt": now_ms(),
        }
    try:
        head = _run(root, ["git", "rev-parse", "HEAD"], timeout=min(2.0, timeout))
    except subprocess.TimeoutExpired:
        head = None
    status = None
    try:
        status = _run(
            root,
            [
                "git",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all" if include_untracked else "--untracked-files=no",
            ],
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        pass

    rows: list[str] = []
    changed: list[str] = []
    tracked_rows: list[str] = []
    tracked_paths: list[str] = []
    untracked_paths: list[str] = []
    status_ok = status is not None and status.returncode == 0
    status_text = status.stdout if status_ok else ""
    if status_ok:
        records = status.stdout.split("\0")
        index = 0
        while index < len(records) and len(rows) < 1000:
            row = records[index]
            index += 1
            if not row:
                continue
            code = row[:2]
            path = row[3:] if len(row) > 3 else row
            if ("R" in code or "C" in code) and index < len(records):
                old = records[index]
                index += 1
                rows.append(f"{code} {old} -> {path}")
                changed.extend((old, path))
                tracked_rows.append(rows[-1])
                tracked_paths.extend((old, path))
            else:
                rows.append(row)
                changed.append(path)
                if code == "??":
                    untracked_paths.append(path)
                else:
                    tracked_rows.append(row)
                    tracked_paths.append(path)

    changed = sorted(dict.fromkeys(path for path in changed if path))
    # Size/mtime/ctime are enough for an invalidation fingerprint and avoid
    # synchronously reading megabytes of changed files on WSL/NTFS.
    stamps: dict[str, bytes] = {}
    for relative in changed:
        path = safe_repo_file(root, relative)
        if path is None:
            stamps[relative] = b"\0missing"
            continue
        try:
            details = path.stat()
            stamps[relative] = (
                f"\0{details.st_size}:{details.st_mtime_ns}:{details.st_ctime_ns}".encode()
            )
        except OSError:
            stamps[relative] = b"\0unreadable"

    def stat_digest(prefix: str, paths: Iterable[str]) -> str:
        digest = hashlib.sha256(prefix.encode("utf-8", errors="surrogateescape"))
        for relative in sorted(dict.fromkeys(item for item in paths if item)):
            digest.update(relative.encode("utf-8", errors="surrogateescape"))
            digest.update(stamps.get(relative, b"\0missing"))
        return digest.hexdigest()[:16]

    digest = hashlib.sha256(status_text.encode())
    for relative in changed:
        digest.update(relative.encode("utf-8", errors="surrogateescape"))
        digest.update(stamps[relative])
    return {
        "git": True,
        "head": head.stdout.strip() if head is not None and head.returncode == 0 else None,
        "status": rows,
        "changed": changed,
        "statusHash": digest.hexdigest()[:16],
        # Identical for fast (tracked-only) and complete captures of the same
        # tree, unlike statusHash; the untracked digest exists only when the
        # capture actually enumerated untracked files.
        "trackedHash": stat_digest("\n".join(tracked_rows), tracked_paths) if status_ok else None,
        "untrackedHash": (
            stat_digest("untracked", untracked_paths) if status_ok and include_untracked else None
        ),
        "changedStamp": _changed_stat_stamp(root, changed),
        "treeStamp": _stamp_digest(_repo_quick_stamp(root)),
        "worktreeStamp": _worktree_stamp(root),
        "partial": status is None or status.returncode != 0,
        "includesUntracked": bool(include_untracked and status is not None and status.returncode == 0),
        "capturedAt": now_ms(),
    }


def _refresh_git_snapshot(key: str, root: Path, generation: int) -> None:
    try:
        try:
            delay_seconds = max(
                0.0,
                float(os.environ.get("OPENCODE_GIT_BACKGROUND_DELAY_SECONDS", "0.75")),
            )
        except ValueError:
            delay_seconds = 0.75
        if delay_seconds:
            time.sleep(delay_seconds)
        try:
            value = _capture_git_snapshot(root, include_untracked=True, timeout=12.0)
        except OSError:
            return  # the directory vanished; the next read captures synchronously
        value["generation"] = generation
        now = time.monotonic()
        with _GIT_SNAPSHOT_LOCK:
            if _GIT_GENERATION.get(key, 0) != generation:
                return
            previous = _GIT_SNAPSHOT_CACHE.get(key)
            # Never replace a usable snapshot with a timed-out background probe.
            if not value.get("partial") or previous is None:
                _GIT_SNAPSHOT_CACHE[key] = (now, _repo_quick_stamp(root), value)
                _GIT_REFRESH_RETRY_AT[key] = now + _git_snapshot_ttl(root)
                _GIT_INVALIDATED.discard(key)
            else:
                # Large WSL/NTFS trees can exceed even the background budget.
                # Back off instead of continuously rescanning them on each turn.
                _GIT_REFRESH_RETRY_AT[key] = now + 30.0
    finally:
        with _GIT_SNAPSHOT_LOCK:
            _GIT_REFRESHING.discard(key)


def _schedule_git_refresh(key: str, root: Path) -> None:
    with _GIT_SNAPSHOT_LOCK:
        now = time.monotonic()
        if key in _GIT_REFRESHING or now < _GIT_REFRESH_RETRY_AT.get(key, 0.0):
            return
        _GIT_REFRESHING.add(key)
        generation = _GIT_GENERATION.get(key, 0)
    threading.Thread(
        target=_refresh_git_snapshot,
        args=(key, root, generation),
        name="custom-opencode-git-refresh",
        daemon=True,
    ).start()


def invalidate_git_snapshot(project_dir: str | None = None) -> None:
    """Forget cached repository state.

    Without a directory everything is dropped (next read captures anew). For
    one project -- a tool just wrote files -- the last snapshot is kept but
    marked stale: readers get it immediately (``stale=True``) and the first
    read schedules a background refresh, instead of paying a synchronous
    `git status` (~0.65 s on 9P) on the interactive path. Callers that need
    the current tree pass ``fresh=True``.
    """
    with _GIT_SNAPSHOT_LOCK:
        if project_dir is None:
            keys = set(_GIT_SNAPSHOT_CACHE) | set(_GIT_REFRESHING) | set(_GIT_GENERATION)
            _GIT_SNAPSHOT_CACHE.clear()
            _GIT_REFRESH_RETRY_AT.clear()
            _GIT_INVALIDATED.clear()
            _GIT_VALIDATOR_SLOW_UNTIL.clear()
            _GIT_VALIDATED_AT.clear()
            for key in keys:
                _GIT_GENERATION[key] = _GIT_GENERATION.get(key, 0) + 1
            return
        key = str(Path(project_dir).resolve(strict=False))
        if key in _GIT_SNAPSHOT_CACHE:
            _GIT_INVALIDATED.add(key)
        _GIT_REFRESH_RETRY_AT.pop(key, None)
        _GIT_GENERATION[key] = _GIT_GENERATION.get(key, 0) + 1


def git_snapshot(
    project_dir: str,
    *,
    refresh: bool = False,
    fresh: bool = False,
) -> dict[str, Any]:
    """Return a bounded, cached repo snapshot.

    Interactive callers receive a fresh cache entry immediately when possible.
    Once an entry exists, expiry is stale-while-revalidate: a complete
    untracked-file scan runs in a daemon thread instead of blocking model/tool
    requests. The first uncached capture intentionally skips untracked files.
    """
    root = Path(project_dir).resolve(strict=False)
    key = str(root)
    now = time.monotonic()
    with _GIT_SNAPSHOT_LOCK:
        cached = _GIT_SNAPSHOT_CACHE.get(key)
        invalidated = key in _GIT_INVALIDATED
    if cached and not refresh and not fresh and invalidated:
        _schedule_git_refresh(key, root)
        return _snapshot_copy(
            cached[2],
            cacheHit=True,
            stale=True,
            invalidated=True,
            ageMs=round((now - cached[0]) * 1000, 2),
        )
    stamp = _repo_quick_stamp(root)
    if (
        cached
        and not refresh
        and not fresh
        and cached[1] == stamp
        and _cached_snapshot_ok(root, key, cached[0], cached[2])
    ):
        age = now - cached[0]
        ttl = _git_snapshot_ttl(root)
        if age >= ttl:
            _schedule_git_refresh(key, root)
        return _snapshot_copy(
            cached[2],
            cacheHit=True,
            stale=age >= ttl,
            ageMs=round(age * 1000, 2),
        )

    # A full refresh is reserved for explicit/background work. A fresh fast
    # capture bypasses cache without enumerating untracked files; this keeps
    # explicit diff/verification reads correct after out-of-band file edits.
    with _GIT_SNAPSHOT_LOCK:
        generation = _GIT_GENERATION.get(key, 0)
    value = _capture_git_snapshot(
        root,
        include_untracked=refresh,
        timeout=12.0 if refresh else 1.25,
    )
    with _GIT_SNAPSHOT_LOCK:
        value["generation"] = generation
        _GIT_SNAPSHOT_CACHE[key] = (time.monotonic(), _repo_quick_stamp(root), value)
        # A write that landed during the capture keeps the snapshot stale.
        if _GIT_GENERATION.get(key, 0) == generation:
            _GIT_INVALIDATED.discard(key)
        else:
            _GIT_INVALIDATED.add(key)
    if not refresh:
        _schedule_git_refresh(key, root)
    return _snapshot_copy(value, cacheHit=False, stale=False, ageMs=0.0)


def _git_toplevel(root: Path) -> str | None:
    """`git rev-parse --show-toplevel`, cached: a checkout does not move."""
    key = str(root)
    cached = _GIT_TOPLEVEL.get(key)
    if cached is not None and time.monotonic() - cached[0] < 300.0:
        return cached[1]
    try:
        proc = _run(root, ["git", "rev-parse", "--show-toplevel"], timeout=4.0)
        top = proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else None
    except (OSError, subprocess.SubprocessError):
        top = None
    _GIT_TOPLEVEL[key] = (time.monotonic(), top)
    return top


def _git_branch(top: Path) -> str:
    """Current branch from HEAD without forking git (worktree .git files too)."""
    try:
        git_dir = top / ".git"
        if git_dir.is_file():
            pointer = git_dir.read_text(encoding="utf-8", errors="replace").strip()
            if not pointer.startswith("gitdir:"):
                raise ValueError("unrecognized .git file")
            git_dir = Path(pointer[len("gitdir:") :].strip())
            git_dir = git_dir if git_dir.is_absolute() else top / git_dir
        head = (git_dir / "HEAD").read_text(encoding="utf-8", errors="replace").strip()
        if head.startswith("ref: "):
            ref = head[5:].strip()
            return ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ""
        return ""  # detached HEAD: `git branch --show-current` prints nothing
    except (OSError, ValueError):
        try:
            proc = _run(top, ["git", "branch", "--show-current"], timeout=4.0)
            return proc.stdout.strip() if proc.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""


def git_repo_info(project_dir: str) -> dict[str, Any]:
    """Top-level, branch and the cached snapshot (for status panels).

    Replaces three uncached git processes per UI poll with the shared,
    stale-while-revalidate snapshot.
    """
    root = Path(project_dir).resolve(strict=False)
    snapshot = git_snapshot(str(root))
    if not snapshot.get("git"):
        return {"available": False, "snapshot": snapshot}
    top = _git_toplevel(root)
    if not top:
        return {"available": False, "snapshot": snapshot}
    return {"available": True, "root": top, "branch": _git_branch(Path(top)), "snapshot": snapshot}


def semantic_diff(
    project_dir: str,
    baseline: dict[str, Any] | None = None,
    *,
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = snapshot or git_snapshot(project_dir, fresh=True)
    baseline = baseline or {}
    root = Path(project_dir).resolve(strict=False)
    files = list(current.get("changed") or [])
    base_head = baseline.get("head")
    current_head = current.get("head")
    if current.get("git") and base_head and current_head and base_head != current_head:
        try:
            proc = _run(
                root,
                ["git", "diff", "--no-ext-diff", "--no-textconv", "--name-status", f"{base_head}..{current_head}"],
                timeout=8.0,
            )
        except subprocess.TimeoutExpired:
            proc = None
        if proc is not None and proc.returncode == 0:
            for line in proc.stdout.splitlines():
                bits = line.split("\t")
                if len(bits) >= 2:
                    files.append(bits[-1])
    stats = {"files": 0, "insertions": 0, "deletions": 0}
    if current.get("git"):
        try:
            proc = _run(
                root,
                ["git", "diff", "--no-ext-diff", "--no-textconv", "--numstat", str(base_head or "HEAD"), "--"],
                timeout=8.0,
            )
        except subprocess.TimeoutExpired:
            proc = None
        if proc is not None and proc.returncode == 0:
            for line in proc.stdout.splitlines():
                bits = line.split("\t")
                if len(bits) >= 3:
                    stats["files"] += 1
                    if bits[0].isdigit():
                        stats["insertions"] += int(bits[0])
                    if bits[1].isdigit():
                        stats["deletions"] += int(bits[1])
    files = sorted(dict.fromkeys(files))[:500]
    stats["files"] = max(stats["files"], len(files))
    return {"baseline": baseline, "current": current, "changedFiles": files, "stats": stats}


class RepoIndexer:
    def __init__(self, store: RuntimeStore):
        self.store = store

    def _key(self, project_dir: str) -> str:
        return hashlib.sha256(project_dir.encode()).hexdigest()

    def refresh(
        self,
        project_dir: str,
        *,
        force: bool = False,
        snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        root = Path(project_dir).resolve(strict=True)
        snapshot = snapshot or git_snapshot(project_dir, fresh=force)
        fingerprint = f"{snapshot.get('head')}:{snapshot.get('statusHash')}:{snapshot.get('treeStamp')}:{snapshot.get('generation')}"
        key = self._key(project_dir)
        cached = self.store.cache_get("repo-index", key)
        if not force and isinstance(cached, dict) and cached.get("fingerprint") == fingerprint:
            cached["cacheHit"] = True
            return cached
        files = []
        listing_timed_out = False
        if snapshot.get("git"):
            try:
                proc = _run(
                    root,
                    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                    timeout=12.0,
                )
            except subprocess.TimeoutExpired:
                proc = None
                listing_timed_out = True
            if proc is not None and proc.returncode == 0:
                files = [item for item in proc.stdout.split("\0") if item][:6000]
        if listing_timed_out and isinstance(cached, dict):
            result = dict(cached)
            result.update(cacheHit=True, stale=True, refreshError="git-ls-files-timeout")
            return result
        if not files:
            for path in root.rglob("*"):
                if not path.is_file() or any(
                    part.startswith(".") for part in path.relative_to(root).parts
                ):
                    continue
                try:
                    files.append(str(path.relative_to(root)))
                except ValueError:
                    continue
                if len(files) >= 3000:
                    break
        files = [relative for relative in files if safe_repo_file(root, relative) is not None]
        symbols = []
        deps = []
        extension_counts = {}
        indexed_bytes = 0
        for relative in files:
            path = safe_repo_file(root, relative)
            if path is None:
                continue
            ext = path.suffix.lower()
            extension_counts[ext or "<none>"] = extension_counts.get(ext or "<none>", 0) + 1
            if path.name in DEPENDENCY_FILES:
                try:
                    text = path.read_text(encoding="utf-8", errors="ignore")[:120000]
                    deps.append(
                        {
                            "path": relative,
                            "sha": hashlib.sha256(text.encode()).hexdigest()[:16],
                            "preview": text[:1500],
                        }
                    )
                except OSError:
                    pass
            if ext not in TEXT_EXTENSIONS or len(symbols) >= 20000:
                continue
            try:
                if path.stat().st_size > 1500000:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            indexed_bytes += len(text.encode("utf-8", errors="ignore"))
            if indexed_bytes > 60000000:
                break
            seen = set()
            for pattern in SYMBOL_PATTERNS:
                for match in pattern.finditer(text):
                    name = match.group(1)
                    if name in seen:
                        continue
                    seen.add(name)
                    symbols.append(
                        {
                            "name": name,
                            "path": relative,
                            "line": text.count("\n", 0, match.start()) + 1,
                        }
                    )
                    if len(symbols) >= 20000:
                        break
                if len(symbols) >= 20000:
                    break
        index = {
            "projectDir": str(root),
            "fingerprint": fingerprint,
            "snapshot": snapshot,
            "files": len(files),
            "symbols": symbols,
            "dependencies": deps,
            "extensions": dict(
                sorted(extension_counts.items(), key=lambda item: (-item[1], item[0]))[:30]
            ),
            "indexedBytes": indexed_bytes,
            "generatedAt": now_ms(),
            "cacheHit": False,
        }
        self.store.cache_set("repo-index", key, index, ttl_seconds=3600)
        return index

    def search(self, project_dir: str, query: str, limit: int = 40) -> dict[str, Any]:
        index = self.refresh(project_dir)
        needle = query.strip().casefold()
        if not needle:
            return {
                "query": query,
                "hits": [],
                "index": {k: index.get(k) for k in ("files", "generatedAt", "fingerprint")},
            }
        terms = [term for term in re.split(r"\s+", needle) if term]
        hits = []
        for symbol in index.get("symbols") or []:
            hay = f"{symbol.get('name','')} {symbol.get('path','')}".casefold()
            score = sum(
                (
                    4
                    if symbol.get("name", "").casefold() == term
                    else (
                        2
                        if term in str(symbol.get("name", "")).casefold()
                        else 1 if term in hay else 0
                    )
                )
                for term in terms
            )
            if score:
                hits.append((score, {"type": "symbol", **symbol}))
        for dep in index.get("dependencies") or []:
            hay = f"{dep.get('path','')} {dep.get('preview','')}".casefold()
            score = sum(1 for term in terms if term in hay)
            if score:
                hits.append(
                    (
                        score,
                        {
                            "type": "dependency",
                            "path": dep.get("path"),
                            "preview": dep.get("preview", "")[:500],
                        },
                    )
                )
        hits.sort(
            key=lambda item: (-item[0], str(item[1].get("path")), str(item[1].get("name", "")))
        )
        return {
            "query": query,
            "hits": [item for _, item in hits[: max(1, min(200, int(limit)))]],
            "index": {k: index.get(k) for k in ("files", "generatedAt", "fingerprint")},
        }


class ArtifactStore:
    INLINE_LIMIT = 24000

    def __init__(self, store: RuntimeStore):
        self.store = store
        with store.transaction() as db:
            if "owner_session" not in {
                row[1] for row in db.execute("PRAGMA table_info(artifacts)")
            }:
                db.execute("ALTER TABLE artifacts ADD COLUMN owner_session TEXT")

    def put(
        self,
        *,
        task_id: str | None,
        project_dir: str | None,
        kind: str,
        title: str,
        content: str | bytes,
        summary: str = "",
        mime: str = "text/plain",
        owner_session: str | None = None,
        compress: bool = False,
    ) -> dict[str, Any]:
        """Store content inline (small text) or as a file.

        ``compress`` gzips the file (``<id>.gz``); size/sha256 always describe
        the logical content and get() decompresses transparently.
        """
        self.store.initialize()
        data = (
            content.encode("utf-8", errors="replace")
            if isinstance(content, str)
            else bytes(content)
        )
        artifact_id = f"a_{uuid4().hex}"
        digest = hashlib.sha256(data).hexdigest()
        inline_text = None
        file_path = None
        if len(data) <= self.INLINE_LIMIT and mime.startswith("text/"):
            inline_text = data.decode("utf-8", errors="replace")
        else:
            directory = self.store.paths.artifacts / (task_id or "shared")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = directory / (artifact_id + (".gz" if compress else ""))
            path.write_bytes(gzip.compress(data, compresslevel=6) if compress else data)
            os.chmod(path, 0o600)
            file_path = str(path)
        with self.store.transaction() as db:
            db.execute(
                "INSERT INTO artifacts(id,task_id,project_dir,kind,title,summary,mime,inline_text,file_path,size_bytes,sha256,created_at,owner_session) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    artifact_id,
                    task_id,
                    project_dir,
                    kind[:80],
                    title[:500],
                    summary[:4000],
                    mime[:160],
                    inline_text,
                    file_path,
                    len(data),
                    digest,
                    now_ms(),
                    owner_session,
                ),
            )
        return {
            "id": artifact_id,
            "taskID": task_id,
            "kind": kind[:80],
            "title": title[:500],
            "summary": summary[:4000],
            "mime": mime,
            "size": len(data),
            "sha256": digest,
            "inline": inline_text is not None,
        }

    def get(
        self,
        artifact_id: str,
        *,
        offset: int = 0,
        limit: int = 64000,
        query: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any] | None:
        self.store.initialize()
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row:
            return None
        if session_id is not None:
            task = self.store.get_task(str(row["task_id"] or ""))
            if (
                not (task and task.get("session_id") == session_id)
                and row["owner_session"] != session_id
            ):
                raise PermissionError("artifact belongs to another session")
        offset = max(0, int(offset))
        limit = max(1, min(500000, int(limit)))
        textual = str(row["mime"]).startswith("text/") or str(row["mime"]) in {
            "application/json",
            "application/javascript",
            "application/xml",
            "application/yaml",
        }
        if not textual:
            try:
                data = self._read_file(str(row["file_path"])) if row["file_path"] else b""
            except (OSError, EOFError, zlib.error):
                data = b""
            return {
                "id": row["id"],
                "taskID": row["task_id"],
                "kind": row["kind"],
                "title": row["title"],
                "summary": row["summary"],
                "mime": row["mime"],
                "size": row["size_bytes"],
                "sha256": row["sha256"],
                "offset": offset,
                "encoding": "base64",
                "content": base64.b64encode(data[offset : offset + limit]).decode("ascii"),
            }
        if row["inline_text"] is not None:
            text = str(row["inline_text"])
        elif row["file_path"] and str(row["file_path"]).endswith(".gz"):
            try:
                text = self._read_file(str(row["file_path"])).decode("utf-8", errors="replace")
                # Same universal-newline view read_text() gives plain files.
                text = text.replace("\r\n", "\n").replace("\r", "\n")
            except (OSError, EOFError, zlib.error):
                text = ""
        elif row["file_path"]:
            try:
                text = Path(str(row["file_path"])).read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
        else:
            text = ""
        if query:
            q = query.casefold()
            lines = text.splitlines()
            matched = []
            for index, line in enumerate(lines):
                if q in line.casefold():
                    used = sum(len(item["context"]) for item in matched)
                    remaining = limit - used
                    if remaining <= 0:
                        break
                    matched.append(
                        {
                            "line": index + 1,
                            "context": "\n".join(
                                lines[max(0, index - 2) : min(len(lines), index + 3)]
                            )[:remaining],
                        }
                    )
                    if len(matched) >= 50:
                        break
            content: Any = matched
        else:
            content = text[offset : offset + limit]
        return {
            "id": row["id"],
            "taskID": row["task_id"],
            "kind": row["kind"],
            "title": row["title"],
            "summary": row["summary"],
            "mime": row["mime"],
            "size": row["size_bytes"],
            "sha256": row["sha256"],
            "offset": offset,
            "content": content,
            "nextOffset": min(len(text), offset + limit),
            "truncated": bool(query) or offset + limit < len(text),
        }

    @staticmethod
    def _read_file(path: str) -> bytes:
        data = Path(path).read_bytes()
        return gzip.decompress(data) if path.endswith(".gz") else data

    def list(self, task_id: str, limit: int = 100) -> list[dict[str, Any]]:
        self.store.initialize()
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT id,kind,title,summary,mime,size_bytes,sha256,created_at FROM artifacts WHERE task_id=? ORDER BY created_at DESC LIMIT ?",
                (task_id, max(1, min(500, int(limit)))),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "kind": r["kind"],
                "title": r["title"],
                "summary": r["summary"],
                "mime": r["mime"],
                "size": r["size_bytes"],
                "sha256": r["sha256"],
                "createdAt": r["created_at"],
            }
            for r in rows
        ]


class ContextService:
    def __init__(self, store: RuntimeStore, indexer: RepoIndexer):
        self.store = store
        self.indexer = indexer

    @staticmethod
    def dedupe(parts: Iterable[str]) -> list[str]:
        seen = set()
        out = []
        for part in parts:
            compact = "\n".join(line.rstrip() for line in str(part).strip().splitlines()).strip()
            if not compact:
                continue
            digest = hashlib.sha256(compact.encode()).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            out.append(compact)
        return out

    def envelope(
        self,
        *,
        project_dir: str,
        task: dict[str, Any] | None,
        project_instructions: str = "",
        budget_chars: int = 24000,
        include_repo: bool = True,
        snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        budget_chars = max(2000, min(120000, int(budget_chars)))
        parts = []
        if project_instructions.strip():
            parts.append("Project instructions:\n" + project_instructions.strip())
        memory = self.store.memory_list(project_dir, limit=20)
        if memory:
            parts.append(
                "Project memory:\n"
                + "\n".join(
                    f"- [{item['category']}] {item['key']}: {item['value']}" for item in memory
                )
            )
        decisions = self.store.decision_list(project_dir, limit=12)
        if decisions:
            parts.append(
                "Active decision log:\n"
                + "\n".join(
                    f"- {item['title']}: {item['decision']}"
                    + (f" ({item['rationale']})" if item["rationale"] else "")
                    for item in decisions
                )
            )
        diff: dict[str, Any] = {}
        if include_repo:
            baseline = task.get("baseline") if task else None
            diff = semantic_diff(
                project_dir,
                baseline if isinstance(baseline, dict) else None,
                snapshot=snapshot,
            )
            changed = diff.get("changedFiles") or []
            if changed:
                stats = diff.get("stats") or {}
                parts.append(
                    f"Semantic diff since task baseline: {len(changed)} changed files, +{stats.get('insertions',0)}/-{stats.get('deletions',0)}.\n"
                    + "\n".join(f"- {path}" for path in changed[:120])
                )
            try:
                index = self.indexer.refresh(project_dir, snapshot=snapshot)
                deps = [str(item.get("path")) for item in index.get("dependencies") or []]
                if deps:
                    parts.append(
                        "Repository dependency/entry files cached by server:\n"
                        + "\n".join(f"- {item}" for item in deps[:40])
                    )
            except Exception:
                pass
        if task:
            inbox = self.store.mailbox_receive(task["id"], consume=False, limit=30)
            if inbox:
                parts.append(
                    "Structured agent mailbox:\n"
                    + "\n".join(
                        f"- {item['type']}: {json.dumps(item['payload'],ensure_ascii=False)[:1200]}"
                        for item in inbox
                    )
                )
            handoff = (
                task.get("metadata", {}).get("handoff")
                if isinstance(task.get("metadata"), dict)
                else None
            )
            if isinstance(handoff, dict):
                parts.append(
                    "Typed handoff:\n" + json.dumps(handoff, ensure_ascii=False, indent=2)[:8000]
                )
        output = []
        used = 0
        omitted = 0
        for part in self.dedupe(parts):
            if used + len(part) + 2 <= budget_chars:
                output.append(part)
                used += len(part) + 2
            else:
                remaining = budget_chars - used
                if remaining > 800:
                    output.append(part[: remaining - 80] + "\n[…server context truncated…]")
                    used = budget_chars
                omitted += 1
                break
        text = "\n\n".join(output)
        return {
            "text": text,
            "budgetChars": budget_chars,
            "usedChars": len(text),
            "omittedSections": omitted,
            "semanticDiff": diff,
        }


def classify_failure(output: str, returncode: int) -> str:
    if returncode == 0:
        return "pass"
    text = output.casefold()
    if returncode in (126, 127):
        return "executable_missing"
    if re.search(r"(?m)^\s*(?:assertion(?:error| failed)?|syntaxerror)\s*:", text):
        return "code"
    if any(
        x in text
        for x in ("command not found", "no such file or directory: 'npm'", "executable not found")
    ):
        return "executable_missing"
    if any(x in text for x in ("operation not permitted", "bwrap:", "namespace creation failed")):
        return "sandbox_denied"
    if any(
        x in text
        for x in (
            "could not resolve host",
            "temporary failure in name resolution",
            "eai_again",
            "enotfound",
            "network is unreachable",
            "connection refused",
        )
    ):
        return "dependency_unavailable"
    if returncode == 124 or "verification timeout" in text or "timed out" in text:
        return "timeout"
    if any(
        x in text
        for x in (
            "assertionerror",
            "assertion failed",
            "assertion:",
            "syntaxerror",
            "error ts",
            "error:",
            "failed",
            "fail ",
            "assert ",
        )
    ):
        return "code"
    return "unknown"


class VerificationPipeline:
    def __init__(self, artifacts: ArtifactStore):
        self.artifacts = artifacts

    def discover(self, project_dir: str) -> list[dict[str, Any]]:
        root = Path(project_dir).resolve(strict=True)
        commands = []
        package = safe_repo_file(root, "package.json")
        if package is not None:
            try:
                data = json.loads(package.read_text(encoding="utf-8"))
                scripts = data.get("scripts") if isinstance(data.get("scripts"), dict) else {}
            except (OSError, json.JSONDecodeError):
                scripts = {}
            runner = (
                "pnpm"
                if (root / "pnpm-lock.yaml").exists()
                else "yarn" if (root / "yarn.lock").exists() else "npm"
            )
            for script in ("lint", "typecheck", "check", "test"):
                if script in scripts:
                    commands.append(
                        {
                            "name": script,
                            "argv": (
                                [runner, "run", script] if runner != "yarn" else ["yarn", script]
                            ),
                        }
                    )
        if (
            safe_repo_file(root, "pyproject.toml") is not None
            or safe_repo_file(root, "pytest.ini") is not None
        ):
            commands.append({"name": "pytest", "argv": [sys.executable, "-m", "pytest", "-q"]})
        if safe_repo_file(root, "Cargo.toml") is not None:
            commands.append({"name": "cargo-check", "argv": ["cargo", "check"]})
        if safe_repo_file(root, "go.mod") is not None:
            commands.append({"name": "go-test", "argv": ["go", "test", "./..."]})
        return commands[:4]

    def run(self, *, task: dict[str, Any], timeout_seconds: int | None = None) -> dict[str, Any]:
        if os.environ.get("OPENCODE_VERIFY_PIPELINE", "auto").strip().lower() in {
            "0",
            "off",
            "false",
            "no",
        }:
            return {"enabled": False, "results": [], "ok": True, "reason": "verification disabled"}
        if os.environ.get("OPENCODE_VERIFY_TRUST_REPO", "0").strip().lower() not in {
            "1",
            "true",
            "yes",
            "on",
        }:
            return {
                "enabled": False,
                "results": [],
                "ok": True,
                "reason": "repository verification requires explicit trust (OPENCODE_VERIFY_TRUST_REPO=1)",
            }
        timeout_seconds = timeout_seconds or int(os.environ.get("OPENCODE_VERIFY_TIMEOUT", "120"))
        results = []
        for command in self.discover(task["project_dir"]):
            started = time.monotonic()
            try:
                proc = _run(
                    Path(task["project_dir"]), command["argv"], timeout=float(timeout_seconds)
                )
                output = (
                    (proc.stdout or "")
                    + ("\n" if proc.stdout and proc.stderr else "")
                    + (proc.stderr or "")
                ).strip()
                classification = classify_failure(output, proc.returncode)
                elapsed = int((time.monotonic() - started) * 1000)
            except subprocess.TimeoutExpired as exc:
                output = f"verification timeout after {timeout_seconds}s: {exc}"
                classification = "timeout"
                elapsed = int((time.monotonic() - started) * 1000)
                proc = None
            except OSError as exc:
                output = str(exc)
                classification = (
                    "executable_missing"
                    if isinstance(exc, FileNotFoundError)
                    else "dependency_unavailable"
                )
                elapsed = int((time.monotonic() - started) * 1000)
                proc = None
            artifact = self.artifacts.put(
                task_id=task["id"],
                project_dir=task["project_dir"],
                kind="verification-log",
                title=f"Verification: {command['name']}",
                content=output,
                summary=f"{classification}: {command['name']}",
            )
            results.append(
                {
                    "name": command["name"],
                    "argv": command["argv"],
                    "returncode": proc.returncode if proc else None,
                    "classification": classification,
                    "elapsedMs": elapsed,
                    "artifactID": artifact["id"],
                    "failureSummary": (
                        "\n".join(output.splitlines()[-30:])[-6000:]
                        if classification != "pass"
                        else ""
                    ),
                }
            )
        return {
            "enabled": True,
            "results": results,
            "ok": all(item["classification"] == "pass" for item in results),
            "actionableFailures": [item for item in results if item["classification"] == "code"],
            "environmentFailures": [
                item for item in results if item["classification"] not in {"pass", "code"}
            ],
        }


def review_decision(project_dir: str, baseline: dict[str, Any] | None = None) -> dict[str, Any]:
    diff = semantic_diff(project_dir, baseline)
    stats = diff.get("stats") or {}
    files = diff.get("changedFiles") or []
    total = int(stats.get("insertions", 0)) + int(stats.get("deletions", 0))
    sensitive = any(
        re.search(
            r"(?i)(auth|security|permission|payment|migration|schema|crypto|secret|\.github/workflows)",
            path,
        )
        for path in files
    )
    needed = sensitive or len(files) > 3 or total > 80
    return {
        "needed": needed,
        "reason": (
            "sensitive/high-impact diff"
            if sensitive
            else "diff size threshold" if needed else "trivial bounded diff"
        ),
        "diff": diff,
    }


class SecretBroker:
    """In-process scoped secret lookup. Values are never serialized by snapshot()."""

    def __init__(self):
        self.allowed_prefixes = tuple(
            item
            for item in os.environ.get(
                "OPENCODE_SECRET_PREFIXES", "TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;GEMINI_;GOOGLE_"
            ).split(";")
            if item
        )

    def resolve(self, name: str, *, scope: str) -> str:
        if not any(name.startswith(prefix) for prefix in self.allowed_prefixes):
            raise PermissionError("secret name outside broker allowlist")
        value = os.environ.get(name)
        if not value:
            raise KeyError(name)
        return value

    def snapshot(self) -> dict[str, Any]:
        names = sorted(
            name
            for name in os.environ
            if any(name.startswith(prefix) for prefix in self.allowed_prefixes)
            and os.environ.get(name)
        )
        return {"availableRefs": names, "plaintextExposed": False, "scoped": True}

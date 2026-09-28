#!/usr/bin/env python3
"""Operator maintenance for the runtime SQLite database (explicit, opt-in).

  stats                      read-only size/free-page/WAL report (default)
  prune                      run the runtime retention pass now, then compact
  checkpoint                 wal_checkpoint(TRUNCATE) (+ incremental_vacuum)
  enable-incremental-vacuum  one-time auto_vacuum=INCREMENTAL + VACUUM

The runtime itself only ever truncates the WAL and runs incremental_vacuum
after its hourly prune; free pages are returned to the filesystem only once
the database was converted with ``enable-incremental-vacuum``. That rewrite
needs exclusive access: stop the web service and the private policy server
first. It refuses while any process holds the runtime worker lease, and it
requires --yes. Never point it at a database you cannot afford to rewrite
without a backup (--backup PATH writes one first).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from runtime_lease import WorkerLease  # noqa: E402
from runtime_store import RuntimeStore  # noqa: E402


def stats(db: Path) -> dict:
    wal = Path(str(db) + "-wal")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
    try:
        pragma = lambda name: con.execute(f"PRAGMA {name}").fetchone()[0]  # noqa: E731
        page_size, pages, free = pragma("page_size"), pragma("page_count"), pragma("freelist_count")
        tables = {
            name: con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        }
        return {
            "db": str(db),
            "fileBytes": db.stat().st_size,
            "walBytes": wal.stat().st_size if wal.exists() else 0,
            "pageSize": page_size,
            "pages": pages,
            "freePages": free,
            "freeBytes": free * page_size,
            "autoVacuum": {0: "none", 1: "full", 2: "incremental"}.get(pragma("auto_vacuum")),
            "journalMode": pragma("journal_mode"),
            "rows": tables,
        }
    finally:
        con.close()


def enable_incremental_vacuum(db: Path, backup: Path | None) -> dict:
    lease = WorkerLease(db.parent)
    if not lease.acquire():
        raise SystemExit(
            "refusing: a runtime worker holds the database lease; stop the web service and the "
            "private policy server first"
        )
    try:
        before = stats(db)
        con = sqlite3.connect(str(db), timeout=30, isolation_level=None)
        try:
            if backup is not None:
                target = sqlite3.connect(str(backup))
                with target:
                    con.backup(target)
                target.close()
            con.execute("PRAGMA auto_vacuum=INCREMENTAL")
            con.execute("VACUUM")  # required once for the mode change to take effect
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        finally:
            con.close()
        return {"before": before, "after": stats(db)}
    finally:
        lease.release()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", nargs="?", default="stats",
                        choices=("stats", "prune", "checkpoint", "enable-incremental-vacuum"))
    parser.add_argument("--db", type=Path, help="runtime database (default: the runtime's own path)")
    parser.add_argument("--retention-days", type=int, default=None)
    parser.add_argument("--backup", type=Path, help="copy the database here before VACUUM")
    parser.add_argument("--yes", action="store_true", help="confirm the one-time VACUUM rewrite")
    args = parser.parse_args()
    store = RuntimeStore(args.db) if args.db else RuntimeStore()
    db = store.paths.db
    if not db.exists():
        raise SystemExit(f"database not found: {db}")
    if args.action == "stats":
        result = stats(db)
    elif args.action == "prune":
        result = {"prune": store.prune(args.retention_days), "after": stats(db)}
    elif args.action == "checkpoint":
        result = {"compact": store.compact(), "after": stats(db)}
    else:
        if not args.yes:
            raise SystemExit("enable-incremental-vacuum rewrites the whole database; re-run with --yes")
        result = enable_incremental_vacuum(db, args.backup)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    raise SystemExit(main())

#!/usr/bin/env python3
"""An expired read must not delete a replacement written by another request."""
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from runtime_store import RuntimeStore, now_ms


with TemporaryDirectory() as directory:
    store = RuntimeStore(Path(directory) / "runtime.sqlite3")
    store.cache_set("race", "item", "old", ttl_seconds=60)
    with store.transaction() as db:
        db.execute("UPDATE cache SET expires_at=?", (now_ms() - 1000,))

    original_transaction = store.transaction

    def replace_before_expired_delete():
        store.transaction = original_transaction
        store.cache_set("race", "item", "fresh", ttl_seconds=60)
        return original_transaction()

    store.transaction = replace_before_expired_delete
    assert store.cache_get("race", "item") is None
    assert store.cache_get("race", "item") == "fresh"

print("Expired cache read preserves concurrent replacement")

"""Read-only native hook snapshot; usable without a public web/backend listener.

The authenticated plugin supplies metadata, not permission decisions. Native
permissions still validate every execution. This adapter is not a second source
of session history and never initiates compaction during context compilation.
"""

from __future__ import annotations
from typing import Any


class NativeContextFeatures:
    def __init__(self, base: Any, snapshot: dict):
        self.base = base
        self.snapshot = snapshot
        self.native_compaction_owned = True
        self.native_context_tokens = max(0, int(snapshot.get("activeContextTokens") or 0))

    def __getattr__(self, name):
        return getattr(self.base, name)

    def _session_directory(self, session_id):
        if session_id != self.snapshot["sessionID"]:
            raise PermissionError("Native snapshot owner mismatch")
        return self.snapshot["directory"]

    def _session_info(self, session_id):
        self._session_directory(session_id)
        return {
            "id": session_id,
            "model": self.snapshot.get("model"),
            "parentID": self.snapshot.get("parentID"),
        }

    def _backend_request_json(self, method, path, *args, **kwargs):
        if method == "GET" and "/api/model" in path:
            record = self.snapshot.get("modelRecord")
            return [record] if isinstance(record, dict) else []
        if method == "GET" and path.endswith("/context"):
            return []
        return self.base._backend_request_json(method, path, *args, **kwargs)

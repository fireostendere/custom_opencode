#!/usr/bin/env python3
"""D&D watcher web endpoints: one session's status, never another's, behind web auth.

Runs the production composition (server_workflow.Handler) on an ephemeral
loopback port against a temporary status directory; no backend, no network.
"""
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
CAMPAIGN = "343ed859-02a4-41f0-85cc-a1b228c503c4"
OTHER_CAMPAIGN = "9d0f1c3e-5b7a-4c2d-8e6f-0a1b2c3d4e5f"


def session(cursor: int, **extra: object) -> dict[str, object]:
    return {
        "agent": "dnd-narrator", "campaignId": CAMPAIGN, "cursor": cursor, "autoWatch": True,
        "watch": {"status": "waiting", "afterSeq": cursor, "auto": True, "errors": 0, "push": True},
        "link": {"state": "live", "since": 1},
        "awake": True, "log": [{"at": 1, "text": "push-канал к ODM подключён"}],
        "context": {"sessionID": "ses_table", "agent": "dnd-narrator", "messageID": "msg_private", "id": "call_private"},
        **extra,
    }


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    state = root / "state" / "dnd-watch"
    os.environ.update({
        "OPENCODE_SERVER_USERNAME": "opencode",
        "OPENCODE_SERVER_PASSWORD": "test-password",
        "OPENCODE_WEB_ALLOW_LOCAL": "1",
        "OPENCODE_AUTH_ALLOW_BASIC": "0",
        "OPENCODE_BACKEND_URL": "http://127.0.0.1:9",
        "OPENCODE_BACKEND_PASSWORD": "backend-test",
        "OPENCODE_SCRATCH_DIRECTORY": str(root / "scratch"),
        "OPENCODE_PROJECT_ROOTS": str(root / "projects"),
        "CUSTOM_OPENCODE_FEATURE_STATE": str(root / "features.json"),
        "CUSTOM_OPENCODE_RUNTIME_DB": str(root / "runtime.sqlite3"),
        "CUSTOM_OPENCODE_STATE_DIR": str(root / "state"),
        "MCP_RAG_ENABLED": "0",
        "OPENCODE_RESOURCE_SCHEDULER": "off",
    })
    (root / "projects").mkdir()
    sys.path.insert(0, str(ROOT / "app"))
    import dnd_watch
    import server_workflow

    base = server_workflow.rag.plus.ext.base
    server_workflow.Handler.log_message = lambda self, *args: None
    server = base.ThreadingHTTPServer(("127.0.0.1", 0), server_workflow.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    local = {"Host": f"127.0.0.1:{port}"}
    remote = {"Host": "table.example.invalid", "X-Forwarded-For": "203.0.113.7"}

    def get(path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection(host, port, timeout=5)
        try:
            connection.request("GET", path, headers=headers or local)
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def status(session_id: str, headers: dict[str, str] | None = None) -> dict[str, object]:
        code, _, raw = get(f"/client-dnd-watch.json?sessionID={session_id}", headers)
        assert code == 200, (code, raw)
        return json.loads(raw)

    def write(name: str, value: object) -> None:
        state.mkdir(parents=True, exist_ok=True)
        (state / name).write_text(json.dumps(value), encoding="utf-8")

    try:
        # No status directory yet: every session is simply not a table.
        before = int(time.time() * 1000)
        value = status("ses_table")
        assert value["present"] is False and set(value) == {"present", "serverNow"}, value
        assert before - 1000 <= value["serverNow"] <= int(time.time() * 1000) + 1000, value

        # Session IDs are validated before touching the disk.
        for bad in ("", "..%2Fetc", "a%20b", "ses%00x", "-ses", "x" * 129):
            code, _, raw = get(f"/client-dnd-watch.json?sessionID={bad}")
            assert code == 400, (bad, code, raw)

        # Same auth as every /client-* endpoint: no loopback bypass through a proxy.
        code, _, _ = get("/client-dnd-watch.json?sessionID=ses_table", remote)
        assert code == 401, code
        code, _, _ = get("/client-dnd-watch-describe.js", remote)
        assert code == 401, code
        cookie = f"{base.AUTH_COOKIE_NAME}={base.issue_session_token(300, 'opencode')}"
        assert status("ses_table", {**remote, "Cookie": cookie})["present"] is False

        # Freshest file wins per session; stoppedAt/updatedAt come from that file;
        # the stored tool context and other sessions never leave the server.
        write("aaaa.json", {"version": 1, "pid": 11, "directory": "/tables/old", "updatedAt": 1_000, "sessions": {
            "ses_table": session(10),
            "ses_neighbour": session(99, campaignId=OTHER_CAMPAIGN, log=[{"at": 2, "text": "чужой журнал"}]),
        }})
        write("bbbb.json", {"version": 1, "pid": 22, "directory": "/tables/new", "updatedAt": 2_000, "stoppedAt": 2_000, "sessions": {
            "ses_table": session(20, turn={"state": "running", "startedAt": 1_900}),
        }})
        value = status("ses_table")
        assert value["present"] is True, value
        snapshot = value["snapshot"]
        assert snapshot["cursor"] == 20 and snapshot["updatedAt"] == 2_000 and snapshot["stoppedAt"] == 2_000, snapshot
        assert snapshot["turn"] == {"state": "running", "startedAt": 1_900}, snapshot
        assert "context" not in snapshot, snapshot
        text = json.dumps(value, ensure_ascii=False)
        for secret in ("msg_private", "call_private", "ses_neighbour", OTHER_CAMPAIGN, "чужой журнал", "/tables/"):
            assert secret not in text, (secret, text)
        neighbour = status("ses_neighbour")["snapshot"]
        assert neighbour["cursor"] == 99 and neighbour["updatedAt"] == 1_000 and "stoppedAt" not in neighbour, neighbour
        assert status("ses_missing")["present"] is False

        # Broken, oversized and foreign files are skipped; the rest keeps working.
        (state / "broken.json").write_text("{not json", encoding="utf-8")
        write("shape.json", {"version": 1, "updatedAt": "soon", "sessions": {"ses_shape": session(1)}})
        write("list.json", ["ses_list"])
        huge = {"version": 1, "updatedAt": 9_000, "sessions": {"ses_huge": session(1, log=[{"at": 1, "text": "x" * (dnd_watch.MAX_FILE_BYTES + 1)}])}}
        write("huge.json", huge)
        (state / "cccc.json.tmp-1-1").write_text(json.dumps({"updatedAt": 9_000, "sessions": {"ses_tmp": session(1)}}), encoding="utf-8")
        for session_id in ("ses_huge", "ses_shape", "ses_list", "ses_tmp"):
            assert status(session_id)["present"] is False, session_id
        assert status("ses_table")["snapshot"]["cursor"] == 20

        # Files are parsed once and re-read only after a change.
        parsed: list[str] = []
        original_parse = dnd_watch._parse
        dnd_watch._parse = lambda path, details: (parsed.append(path.name), original_parse(path, details))[1]
        try:
            status("ses_table")
            assert parsed == [], parsed
            write("bbbb.json", {"version": 1, "pid": 22, "directory": "/tables/new", "updatedAt": 3_000, "sessions": {"ses_table": session(21)}})
            snapshot = status("ses_table")["snapshot"]
            assert parsed == ["bbbb.json"], parsed
            assert snapshot["cursor"] == 21 and "stoppedAt" not in snapshot, snapshot
        finally:
            dnd_watch._parse = original_parse
        (state / "bbbb.json").unlink()
        assert status("ses_table")["snapshot"]["cursor"] == 10, "a removed file stops counting"

        # The web view model is the TUI's own file, served verbatim with a validator.
        code, headers, body = get("/client-dnd-watch-describe.js")
        shared = (ROOT / "config/plugins/tui/lib/dnd-watch-describe.js").read_bytes()
        assert code == 200 and body == shared, code
        assert headers["content-type"] == "text/javascript; charset=utf-8", headers
        assert headers["x-content-type-options"] == "nosniff" and headers["cache-control"] == "no-cache", headers
        assert b"import " not in shared, "the shared view model must stay import-free for the browser"
        code, _, body = get("/client-dnd-watch-describe.js", {**local, "If-None-Match": headers["etag"]})
        assert code == 304 and body == b"", code
        # Another site may not load it either.
        code, _, _ = get("/client-dnd-watch-describe.js", {**local, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"})
        assert code == 403, code
    finally:
        server.shutdown()
        server.server_close()

print("DnD watcher web: auth, session-id validation, freshest-file selection, per-session privacy, broken/huge files, mtime cache and shared view module passed")

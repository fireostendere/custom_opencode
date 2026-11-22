#!/usr/bin/env python3
"""Offline memory/lifecycle regressions: Git caches, usage pages and artifacts.

Uses the real runtime functions with synthetic native pages/Git observations
and real temporary files/SQLite. No running service, socket or model is needed.
"""
from __future__ import annotations

import base64
import gc
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import tracemalloc
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
TEST_STATE = tempfile.TemporaryDirectory(prefix="opencode-memory-backend-")
os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(Path(TEST_STATE.name) / "bootstrap.sqlite3")
import repo_services  # noqa: E402
import server_runtime  # noqa: E402
from repo_services import ArtifactStore  # noqa: E402
from runtime_store import RuntimeStore  # noqa: E402

MiB = 1024 * 1024


def memory(call):
    gc.collect()
    tracemalloc.start()
    try:
        result = call()
        gc.collect()
        retained, peak = tracemalloc.get_traced_memory()
        return result, retained, peak
    finally:
        tracemalloc.stop()


class UsagePagesTests(unittest.TestCase):
    def test_signature_totals_and_overlapping_pages_remain_identical(self):
        rows = [
            {"info": {"id": f"m-{n}", "tokens": {"input": 1, "output": 2.9, "reasoning": -3,
                                                    "cache": {"read": 4, "write": 5}}, "cost": 0.25},
             "parts": [{"type": "tool", "text": "Ж" * 5000 + f" output {n}"}]}
            for n in range(35)
        ]
        anonymous = {"tokens": {"input": 3}, "text": "anonymous"}
        pages = [rows[:20] + [None, "invalid"], rows[18:] + [anonymous, anonymous]]
        cursor = iter(pages)
        calls = []

        def fetch(method, path, **kwargs):
            calls.append(path)
            return {"data": next(cursor), "cursor": {"next": "p2" if len(calls) == 1 else None}}

        got = server_runtime._usage_totals(SimpleNamespace(_backend_request_json=fetch, _data=lambda x: x["data"]), "a/b")
        expected_tail = rows[-18:] + [anonymous, anonymous]
        signature = hashlib.sha256("\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True, default=str)[-4000:]
                                              for row in expected_tail).encode()).hexdigest()[:20]
        self.assertEqual(got, {"available": True, "input": 41, "output": 70, "reasoning": 0,
                               "cacheRead": 140, "cacheWrite": 175, "cost": 8.75, "signature": signature})
        self.assertIn("/a%2Fb/message?limit=200&order=asc", calls[0])
        self.assertIn("&cursor=p2", calls[1])

    def test_partial_failures_never_return_partial_usage(self):
        for failure in (OSError("offline"), {"data": "malformed"}, {"data": [], "cursor": {"next": "p2"}}):
            with self.subTest(failure=str(failure)):
                responses = iter([{"data": [{"info": {"id": "first", "tokens": {"input": 99}}}], "cursor": {"next": "p2"}}, failure])

                def fetch(*args, **kwargs):
                    response = next(responses)
                    if isinstance(response, Exception):
                        raise response
                    return response

                got = server_runtime._usage_totals(SimpleNamespace(_backend_request_json=fetch, _data=lambda x: x["data"]), "s")
                self.assertFalse(got["available"])
                self.assertEqual(got["signature"], "")
                self.assertEqual(got["input"], 0)

    def test_page_safety_limit_is_preserved(self):
        calls = [0]

        def fetch(*args, **kwargs):
            calls[0] += 1
            return {"data": [], "cursor": {"next": str(calls[0])}}

        got = server_runtime._usage_totals(SimpleNamespace(_backend_request_json=fetch, _data=lambda x: x["data"]), "s")
        self.assertEqual(calls[0], 1000)
        self.assertFalse(got["available"])
        self.assertIn("page safety limit", got["error"])

    def test_peak_stays_page_sized_as_history_grows(self):
        peaks = []
        for count in (200, 2000, 4000):
            def fetch(method, path, **kwargs):
                params = parse_qs(urlsplit(path).query)
                start = int(params.get("cursor", ["0"])[0])
                end = min(count, start + 200)
                rows = [{"info": {"id": f"m-{n}", "tokens": {"input": 1}},
                         "parts": [{"type": "tool", "state": {"output": f"{n}:" + "x" * 16384}}]}
                        for n in range(start, end)]
                return {"data": rows, "cursor": {"next": str(end) if end < count else None}}

            features = SimpleNamespace(_backend_request_json=fetch, _data=lambda x: x["data"])
            got, retained, peak = memory(lambda: server_runtime._usage_totals(features, "s"))
            self.assertEqual(got["input"], count)
            self.assertTrue(got["available"])
            self.assertLess(retained, MiB)
            self.assertLess(peak, 8 * MiB, f"history retained instead of one page: {peak / MiB:.2f} MiB")
            peaks.append(peak)
        self.assertLess(peaks[-1] - peaks[0], 2 * MiB)


class ArtifactStreamingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="opencode-artifact-memory-")
        self.addCleanup(self.temp.cleanup)
        self.store = RuntimeStore(Path(self.temp.name) / "runtime.sqlite3")
        self.artifacts = ArtifactStore(self.store)

    def put(self, content, *, compressed=False, inline=False, binary=False):
        return self.artifacts.put(task_id=None, project_dir=None, kind="test", title="fixture", content=content,
                                  mime="application/octet-stream" if binary else "text/plain" if inline else "application/json",
                                  compress=compressed)

    @staticmethod
    def expected(text, offset, limit, query=None):
        offset, limit = max(0, offset), max(1, min(500000, limit))
        if query:
            lines, output, used = text.splitlines(), [], 0
            for index, line in enumerate(lines):
                if query.casefold() in line.casefold() and used < limit:
                    context = "\n".join(lines[max(0, index - 2):index + 3])[:limit - used]
                    output.append({"line": index + 1, "context": context})
                    used += len(context)
                    if len(output) == 50:
                        break
        else:
            output = text[offset:offset + limit]
        return output, min(len(text), offset + limit), bool(query) or offset + limit < len(text)

    def test_utf8_newlines_offsets_limits_and_query_context(self):
        text = "ноль\r\nStraße один\rдва\nтрёх🧪\vчетыре\fпять\x1cшесть\x1dсемь\x1eвосемь\x85девять\u2028десять\u2029Straße хвост\r\n"
        for inline, compressed in ((True, False), (False, False), (False, True)):
            artifact = self.put(text, inline=inline, compressed=compressed)
            expected_text = text if inline else text.replace("\r\n", "\n").replace("\r", "\n")
            for offset in (-10, 0, 1, 7, len(expected_text) - 1, len(expected_text), len(expected_text) + 5):
                for limit in (-10, 0, 1, 4, 1000):
                    got = self.artifacts.get(artifact["id"], offset=offset, limit=limit)
                    self.assertEqual((got["content"], got["nextOffset"], got["truncated"]), self.expected(expected_text, offset, limit))
            for query in ("STRASSE", "🧪", "семь", "missing", "\n"):
                for limit in (1, 8, 30, 1000):
                    got = self.artifacts.get(artifact["id"], offset=17, query=query, limit=limit)
                    self.assertEqual((got["content"], got["nextOffset"], got["truncated"]), self.expected(expected_text, 17, limit, query))

    def test_query_empty_trailing_lines_overlaps_and_match_limit(self):
        for text in ("", "\n", "\n\n", "hit", "hit\r\nhit", "\n".join(f"hit {n}" for n in range(80))):
            artifact = self.put(text)
            expected_text = text.replace("\r\n", "\n").replace("\r", "\n")
            for limit in (1, 17, 100000):
                got = self.artifacts.get(artifact["id"], offset=999, limit=limit, query="hit")
                self.assertEqual((got["content"], got["nextOffset"], got["truncated"]), self.expected(expected_text, 999, limit, "hit"))

    def test_query_crosses_chunks_casefold_and_crlf_boundaries(self):
        # Small chunk size exercises separators and matching at every boundary;
        # StringIO preserves CRLF just like legacy inline text.
        text = "before\r\n" + "Ж" * 31 + "Straße" + "x" * 50 + "\r\nafter\u2028last\n"
        with patch.object(repo_services, "_ARTIFACT_READ_CHARS", 7):
            for query in ("strasse", "жstraße", "after", "last", "never"):
                self.assertEqual(repo_services._artifact_text_page(io.StringIO(text), 0, 90, query), self.expected(text, 0, 90, query))

    def test_binary_plain_and_gzip_ranges_are_byte_offsets(self):
        body = bytes(range(256)) * 256
        for compressed in (False, True):
            artifact = self.put(body, binary=True, compressed=compressed)
            for offset in (-1, 0, 1, 173, len(body) - 1, len(body) + 5):
                for limit in (-1, 0, 1, 511):
                    got = self.artifacts.get(artifact["id"], offset=offset, limit=limit)
                    start, size = max(0, offset), max(1, limit)
                    self.assertEqual(base64.b64decode(got["content"]), body[start:start + size])
                    self.assertEqual(got["encoding"], "base64")

    def test_invalid_utf8_missing_and_corrupt_files_preserve_error_shape(self):
        body = b"a\xff\xe2\x82\r\nb"
        for compressed in (False, True):
            artifact = self.put(body, compressed=compressed)
            got = self.artifacts.get(artifact["id"])
            self.assertEqual(got["content"], body.decode("utf-8", errors="replace").replace("\r\n", "\n"))
            with self.store.connect() as db:
                path = Path(db.execute("SELECT file_path FROM artifacts WHERE id=?", (artifact["id"],)).fetchone()[0])
            if compressed:
                path.write_bytes(b"invalid gzip")
            else:
                path.unlink()
            got = self.artifacts.get(artifact["id"], query="x")
            self.assertEqual((got["content"], got["nextOffset"], got["truncated"]), ([], 0, True))
            got = self.artifacts.get(artifact["id"])
            self.assertEqual((got["content"], got["nextOffset"], got["truncated"]), ("", 0, False))

    def test_small_page_does_not_allocate_whole_large_artifact(self):
        for binary in (False, True):
            for compressed in (False, True):
                artifact = self.put("x" * (32 * MiB), binary=binary, compressed=compressed)
                got, retained, peak = memory(lambda: self.artifacts.get(artifact["id"], limit=1000))
                self.assertEqual(len(base64.b64decode(got["content"])) if binary else len(got["content"]), 1000)
                self.assertLess(peak, 2 * MiB)
                self.assertLess(retained, MiB)

    def test_search_huge_single_line_is_bounded_and_still_finds_its_tail(self):
        body = "before\n" + "x" * (16 * MiB) + "Straße\nafter\nlast\n"
        for compressed in (False, True):
            artifact = self.put(body, compressed=compressed)
            got, retained, peak = memory(lambda: self.artifacts.get(artifact["id"], query="STRASSE", limit=1000))
            self.assertEqual(got["content"], [{"line": 2, "context": "before\n" + "x" * 993}])
            self.assertEqual(got["nextOffset"], 1000)
            self.assertLess(peak, 3 * MiB, f"single line was retained: {peak / MiB:.2f} MiB")


class GitCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="opencode-git-cache-")
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {"OPENCODE_GIT_CACHE_MAX_PROJECTS": "8", "OPENCODE_GIT_CACHE_MAX_BYTES": str(2 * MiB),
                                          "OPENCODE_GIT_BACKGROUND_DELAY_SECONDS": "0", "OPENCODE_GIT_SNAPSHOT_TTL_SECONDS": "60"})
        self.env.start()
        self.addCleanup(self.env.stop)
        repo_services.invalidate_git_snapshot()
        self.addCleanup(repo_services.invalidate_git_snapshot)
        repo_services._SLOW_FS.clear()
        repo_services._GIT_TOPLEVEL.clear()
        self.release = []
        self.threads = []
        self.addCleanup(self.finish_threads)

    def root(self, name):
        return str(Path(self.temp.name) / name)

    @staticmethod
    def snapshot(root, *, label="base", heavy=False, **kwargs):
        paths = [f"{root.name}/source-{n:04d}-" + "x" * 120 for n in range(1000)] if heavy else []
        return {"git": False, "head": label, "statusHash": label, "status": [" M " + x for x in paths],
                "changed": paths, "changedStamp": repo_services._changed_stat_stamp(root, []), "partial": False}

    def finish_threads(self):
        for event in self.release:
            event.set()
        for thread in self.threads:
            thread.join(3)

    def start_refresh(self, root):
        original = threading.Thread

        def spawn(*args, **kwargs):
            thread = original(*args, **kwargs)
            self.threads.append(thread)
            return thread

        with patch.object(repo_services.threading, "Thread", side_effect=spawn):
            repo_services._schedule_git_refresh(root, Path(root))
        return self.threads[-1]

    def test_lru_access_and_metadata_eviction(self):
        with patch.dict(os.environ, {"OPENCODE_GIT_CACHE_MAX_PROJECTS": "2"}), patch.object(repo_services, "_capture_git_snapshot", side_effect=self.snapshot):
            a, b, c = (self.root(n) for n in ("a", "b", "c"))
            repo_services.git_snapshot(a, refresh=True)
            repo_services.git_snapshot(b, refresh=True)
            repo_services.invalidate_git_snapshot(b)
            repo_services._GIT_VALIDATED_AT[b] = time.monotonic()
            repo_services._GIT_VALIDATOR_SLOW_UNTIL[b] = time.monotonic() + 500
            repo_services.slow_filesystem(Path(b))
            self.assertTrue(repo_services.git_snapshot(a)["cacheHit"])
            repo_services.git_snapshot(c, refresh=True)
            self.assertEqual(set(repo_services._GIT_SNAPSHOT_CACHE), {a, c})
            for memo in (repo_services._GIT_GENERATION, repo_services._GIT_VALIDATED_AT, repo_services._GIT_VALIDATOR_SLOW_UNTIL,
                         repo_services._GIT_INVALIDATED, repo_services._SLOW_FS, repo_services._GIT_SNAPSHOT_SIZES):
                self.assertNotIn(b, memo)

    def test_byte_budget_and_retained_memory_plateau(self):
        points = []
        with patch.object(repo_services, "_capture_git_snapshot", side_effect=lambda root, **kwargs: self.snapshot(root, heavy=True)):
            gc.collect()
            tracemalloc.start()
            try:
                for n in range(200):
                    repo_services.git_snapshot(self.root(f"worktree-{n}"), refresh=True)
                    if n in (19, 99, 199):
                        gc.collect()
                        retained, peak = tracemalloc.get_traced_memory()
                        points.append(retained)
                        self.assertLessEqual(repo_services._GIT_SNAPSHOT_BYTES, 2 * MiB)
                        self.assertLessEqual(len(repo_services._GIT_ROOTS), 8)
                        self.assertLess(retained, 3 * MiB)
            finally:
                tracemalloc.stop()
        self.assertLess(points[-1] - points[0], MiB // 2)
        repo_services.invalidate_git_snapshot()
        self.assertEqual(repo_services._GIT_SNAPSHOT_BYTES, 0)
        self.assertFalse(repo_services._GIT_GENERATION)

    def test_oversized_snapshot_is_returned_without_being_cached(self):
        with patch.dict(os.environ, {"OPENCODE_GIT_CACHE_MAX_BYTES": "1024"}), patch.object(repo_services, "_capture_git_snapshot", side_effect=lambda root, **kwargs: self.snapshot(root, heavy=True)):
            got = repo_services.git_snapshot(self.root("large"), refresh=True)
        self.assertEqual(len(got["changed"]), 1000)
        self.assertFalse(repo_services._GIT_SNAPSHOT_CACHE)
        self.assertEqual(repo_services._GIT_SNAPSHOT_BYTES, 0)

    def test_probes_and_write_only_roots_are_also_bounded(self):
        with patch.object(repo_services, "_run", return_value=SimpleNamespace(returncode=0, stdout="/repo\n")):
            for n in range(80):
                root = self.root(str(n))
                repo_services.invalidate_git_snapshot(root)
                repo_services.slow_filesystem(Path(root))
                repo_services._git_toplevel(Path(root))
        for memo in (repo_services._GIT_ROOTS, repo_services._GIT_GENERATION, repo_services._SLOW_FS, repo_services._GIT_TOPLEVEL):
            self.assertLessEqual(len(memo), 8)

    def test_background_capture_cannot_overwrite_a_concurrent_tool_write(self):
        a = self.root("a")
        started, release = threading.Event(), threading.Event()
        self.release.append(release)

        def capture(root, **kwargs):
            if threading.current_thread() is not threading.main_thread():
                started.set()
                release.wait(3)
                return self.snapshot(root, label="stale-background")
            return self.snapshot(root)

        with patch.object(repo_services, "_capture_git_snapshot", side_effect=capture):
            repo_services.git_snapshot(a, refresh=True)
            thread = self.start_refresh(a)
            self.assertTrue(started.wait(2))
            repo_services.invalidate_git_snapshot(a)
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(repo_services._GIT_SNAPSHOT_CACHE[a][2]["head"], "base")
        self.assertIn(a, repo_services._GIT_INVALIDATED)
        self.assertNotIn(a, repo_services._GIT_REFRESHING)

    def test_evicted_and_revisited_root_rejects_old_refresh_and_keeps_new_marker(self):
        a, b = self.root("a"), self.root("b")
        old_started, old_release, new_started, new_release = (threading.Event() for _ in range(4))
        self.release.extend((old_release, new_release))
        background = [0]

        def capture(root, **kwargs):
            if threading.current_thread() is not threading.main_thread():
                background[0] += 1
                if background[0] == 1:
                    old_started.set()
                    old_release.wait(3)
                    return self.snapshot(root, label="old-incarnation")
                new_started.set()
                new_release.wait(3)
                return self.snapshot(root, label="new-background")
            return self.snapshot(root, label="foreground")

        with patch.dict(os.environ, {"OPENCODE_GIT_CACHE_MAX_PROJECTS": "1"}), patch.object(repo_services, "_capture_git_snapshot", side_effect=capture):
            repo_services.git_snapshot(a, refresh=True)
            old = self.start_refresh(a)
            self.assertTrue(old_started.wait(2))
            repo_services.git_snapshot(b, refresh=True)  # evicts A and its generation
            repo_services.git_snapshot(a, refresh=True)  # A is back at generation zero
            new = self.start_refresh(a)
            self.assertTrue(new_started.wait(2))
            marker = repo_services._GIT_REFRESH_TOKENS[a]
            old_release.set()
            old.join(3)
            self.assertFalse(old.is_alive())
            self.assertEqual(repo_services._GIT_SNAPSHOT_CACHE[a][2]["head"], "foreground")
            self.assertIn(a, repo_services._GIT_REFRESHING)
            self.assertIs(repo_services._GIT_REFRESH_TOKENS[a], marker)
            new_release.set()
            new.join(3)
            self.assertFalse(new.is_alive())
            self.assertEqual(repo_services._GIT_SNAPSHOT_CACHE[a][2]["head"], "new-background")

    def test_global_clear_prevents_background_resurrection(self):
        a = self.root("a")
        started, release = threading.Event(), threading.Event()
        self.release.append(release)

        def capture(root, **kwargs):
            if threading.current_thread() is not threading.main_thread():
                started.set()
                release.wait(3)
            return self.snapshot(root)

        with patch.object(repo_services, "_capture_git_snapshot", side_effect=capture):
            repo_services.git_snapshot(a, refresh=True)
            thread = self.start_refresh(a)
            self.assertTrue(started.wait(2))
            repo_services.invalidate_git_snapshot()
            release.set()
            thread.join(3)
        self.assertFalse(repo_services._GIT_ROOTS)
        self.assertFalse(repo_services._GIT_SNAPSHOT_CACHE)
        self.assertFalse(repo_services._GIT_REFRESHING)
        self.assertFalse(repo_services._GIT_REFRESH_RETRY_AT)
        self.assertEqual(repo_services._GIT_SNAPSHOT_BYTES, 0)

    def test_thread_start_failure_leaves_refresh_retryable(self):
        a = self.root("a")
        with patch.object(repo_services, "_capture_git_snapshot", side_effect=self.snapshot):
            repo_services.git_snapshot(a, refresh=True)
        with patch.object(repo_services.threading.Thread, "start", side_effect=RuntimeError("no thread")):
            with self.assertRaises(RuntimeError):
                repo_services._schedule_git_refresh(a, Path(a))
        self.assertNotIn(a, repo_services._GIT_REFRESHING)
        self.assertNotIn(a, repo_services._GIT_REFRESH_TOKENS)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        TEST_STATE.cleanup()

#!/usr/bin/env python3
"""Regression checks for the interactive performance hot path."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

import repo_services


class FakeStore:
    def memory_list(self, project_dir, limit=20):
        return []

    def decision_list(self, project_dir, limit=12):
        return []

    def mailbox_receive(self, task_id, consume=False, limit=30):
        return []


class BombIndexer:
    def refresh(self, *args, **kwargs):
        raise AssertionError("legacy repo indexer entered the V3 hot path")


def completed(args, stdout="", returncode=0):
    return subprocess.CompletedProcess(args=args, returncode=returncode, stdout=stdout, stderr="")


def main() -> None:
    previous_delay = os.environ.get("OPENCODE_GIT_BACKGROUND_DELAY_SECONDS")
    previous_ttl = os.environ.get("OPENCODE_GIT_SNAPSHOT_TTL_SECONDS")
    os.environ["OPENCODE_GIT_BACKGROUND_DELAY_SECONDS"] = "60"
    os.environ["OPENCODE_GIT_SNAPSHOT_TTL_SECONDS"] = "30"
    original_run = repo_services._run
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            status_calls = 0

            def timeout_run(cwd, args, timeout=12.0, input_text=None):
                nonlocal status_calls
                if args[:3] == ["git", "rev-parse", "--is-inside-work-tree"]:
                    return completed(args, "true\n")
                if args[:3] == ["git", "rev-parse", "HEAD"]:
                    return completed(args, "deadbeef\n")
                if args[:2] == ["git", "status"]:
                    status_calls += 1
                    raise subprocess.TimeoutExpired(args, timeout)
                raise AssertionError(args)

            repo_services.invalidate_git_snapshot()
            repo_services._run = timeout_run
            first = repo_services.git_snapshot(str(root))
            second = repo_services.git_snapshot(str(root))
            assert first["git"] is True
            assert first["partial"] is True
            assert first["cacheHit"] is False
            assert second["cacheHit"] is True
            assert status_calls == 1, "cached snapshot must suppress duplicate git status calls"

            repo_services.invalidate_git_snapshot(str(root))
            status_calls = 0

            def fast_run(cwd, args, timeout=12.0, input_text=None):
                nonlocal status_calls
                if args[:3] == ["git", "rev-parse", "--is-inside-work-tree"]:
                    return completed(args, "true\n")
                if args[:3] == ["git", "rev-parse", "HEAD"]:
                    return completed(args, "cafebabe\n")
                if args[:2] == ["git", "status"]:
                    status_calls += 1
                    assert "--untracked-files=no" in args
                    return completed(args, "")
                raise AssertionError(args)

            repo_services._run = fast_run
            first = repo_services.git_snapshot(str(root))
            second = repo_services.git_snapshot(str(root))
            assert first["partial"] is False
            assert second["statusHash"] == first["statusHash"]
            assert status_calls == 1

            # Runtime V3 explicitly disables the legacy repo/index pipeline in
            # ContextService; otherwise one turn performs the same repo work twice.
            context = repo_services.ContextService(FakeStore(), BombIndexer())
            envelope = context.envelope(
                project_dir=str(root),
                task=None,
                budget_chars=4000,
                include_repo=False,
                snapshot=first,
            )
            assert envelope["text"] == ""

        runtime_v3 = (ROOT / "app/runtime_v3.py").read_text(encoding="utf-8")
        assert "snapshot = git_snapshot(directory)" in runtime_v3
        assert "include_repo=False" in runtime_v3
        assert "snapshot=snapshot" in runtime_v3
        guard = (ROOT / "config/plugins/server-runtime-guard.js").read_text(encoding="utf-8")
        assert "CONTEXT_HOT_PATH_WAIT_MS" in guard
        assert "refreshManagedContext" in guard
        print("Performance hot-path regression PASS")
    finally:
        repo_services._run = original_run
        repo_services.invalidate_git_snapshot()
        if previous_delay is None:
            os.environ.pop("OPENCODE_GIT_BACKGROUND_DELAY_SECONDS", None)
        else:
            os.environ["OPENCODE_GIT_BACKGROUND_DELAY_SECONDS"] = previous_delay
        if previous_ttl is None:
            os.environ.pop("OPENCODE_GIT_SNAPSHOT_TTL_SECONDS", None)
        else:
            os.environ["OPENCODE_GIT_SNAPSHOT_TTL_SECONDS"] = previous_ttl


if __name__ == "__main__":
    main()

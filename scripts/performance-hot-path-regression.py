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
                if args[:2] == ["git", "diff-files"]:
                    return completed(args, "")
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

            # A tool write invalidates one project: the last snapshot is served
            # (stale) and refreshed in the background -- never a synchronous
            # `git status` on the interactive path.
            repo_services.invalidate_git_snapshot(str(root))
            stale = repo_services.git_snapshot(str(root))
            assert stale["stale"] is True and stale.get("invalidated") is True, stale
            assert stale["statusHash"] == first["statusHash"]
            assert status_calls == 1, "invalidation must not capture synchronously"
            assert str(root.resolve()) in repo_services._GIT_REFRESHING, "refresh not scheduled"
            with repo_services._GIT_SNAPSHOT_LOCK:
                repo_services._GIT_REFRESHING.discard(str(root.resolve()))
            # Explicit fresh reads still bypass the stale entry.
            fresh = repo_services.git_snapshot(str(root), fresh=True)
            assert fresh["cacheHit"] is False and status_calls == 2
            with repo_services._GIT_SNAPSHOT_LOCK:
                repo_services._GIT_REFRESHING.discard(str(root.resolve()))

            repo_services.invalidate_git_snapshot()
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
                if args[:2] == ["git", "diff-files"]:
                    return completed(args, "")
                raise AssertionError(args)

            repo_services._run = fast_run
            first = repo_services.git_snapshot(str(root))
            second = repo_services.git_snapshot(str(root))
            assert first["partial"] is False
            assert second["statusHash"] == first["statusHash"]
            assert status_calls == 1

            def diff_timeout_run(cwd, args, timeout=12.0, input_text=None):
                if args[:2] == ["git", "diff"]:
                    raise subprocess.TimeoutExpired(args, timeout)
                return fast_run(cwd, args, timeout, input_text)

            repo_services._run = diff_timeout_run
            diff = repo_services.semantic_diff(
                str(root),
                {"head": "parent"},
                snapshot={**first, "head": "child", "git": True, "changed": ["tracked.py"]},
            )
            assert diff["changedFiles"] == ["tracked.py"]
            assert diff["stats"]["files"] == 1

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

            # The diff-files validator cannot meet its budget on 9P; after one
            # timeout it is skipped for that root instead of fork+kill per hit.
            repo_services.invalidate_git_snapshot()
            validator_calls = 0

            def slow_validator_run(cwd, args, timeout=12.0, input_text=None):
                nonlocal validator_calls
                if args[:2] == ["git", "diff-files"]:
                    validator_calls += 1
                    raise subprocess.TimeoutExpired(args, timeout)
                return fast_run(cwd, args, timeout, input_text)

            repo_services._run = slow_validator_run
            repo_services.git_snapshot(str(root))
            for _ in range(3):
                assert repo_services.git_snapshot(str(root))["cacheHit"] is True
            assert validator_calls == 1, validator_calls

            # Fast (tracked-only) and complete captures agree on trackedHash;
            # statusHash differs whenever untracked files exist.
            def untracked_run(cwd, args, timeout=12.0, input_text=None):
                if args[:2] == ["git", "status"]:
                    body = " M tracked.py\0"
                    if "--untracked-files=all" in args:
                        body += "?? new.py\0"
                    return completed(args, body)
                return fast_run(cwd, args, timeout, input_text)

            repo_services._run = untracked_run
            (root / "tracked.py").write_text("x = 1\n", encoding="utf-8")
            (root / "new.py").write_text("y = 2\n", encoding="utf-8")
            quick = repo_services._capture_git_snapshot(root, include_untracked=False, timeout=1.0)
            complete = repo_services._capture_git_snapshot(root, include_untracked=True, timeout=1.0)
            assert quick["statusHash"] != complete["statusHash"]
            assert quick["trackedHash"] == complete["trackedHash"]
            assert quick["untrackedHash"] is None and complete["untrackedHash"]

            # 9P-aware TTL (only when no explicit TTL is configured).
            os.environ.pop("OPENCODE_GIT_SNAPSHOT_TTL_SECONDS", None)
            repo_services._SLOW_FS.clear()
            assert repo_services._git_snapshot_ttl(Path("/mnt/c/Users/project")) >= 15.0
            assert repo_services._git_snapshot_ttl(root) == 1.5
            assert repo_services.slow_filesystem(Path("/mnt/c/Users/project"))
            os.environ["OPENCODE_GIT_SNAPSHOT_TTL_SECONDS"] = "30"

            # On 9P a cache hit re-validates dirty-file stats at most every few
            # seconds (each lstat costs ~1 ms there); elsewhere on every hit.
            stat_checks = 0
            original_stamp = repo_services._changed_stat_stamp

            def counting_stamp(*args, **kwargs):
                nonlocal stat_checks
                stat_checks += 1
                return original_stamp(*args, **kwargs)

            repo_services._changed_stat_stamp = counting_stamp
            try:
                repo_services._SLOW_FS[str(root.resolve())] = True
                repo_services.invalidate_git_snapshot()
                repo_services._run = fast_run
                repo_services.git_snapshot(str(root))
                baseline_checks = stat_checks
                for _ in range(5):
                    assert repo_services.git_snapshot(str(root))["cacheHit"] is True
                assert stat_checks == baseline_checks, "9P cache hits re-stat dirty files"
                repo_services._SLOW_FS[str(root.resolve())] = False
                repo_services.git_snapshot(str(root))
                assert stat_checks == baseline_checks + 1
            finally:
                repo_services._changed_stat_stamp = original_stamp
                repo_services._SLOW_FS.clear()

        # Branch for the unified panel comes from HEAD, not a git process.
        with tempfile.TemporaryDirectory() as tmp:
            top = Path(tmp)
            (top / ".git").mkdir()
            (top / ".git" / "HEAD").write_text("ref: refs/heads/feature/x\n", encoding="utf-8")

            def no_git(*_args, **_kwargs):
                raise AssertionError("git branch must not be spawned")

            repo_services._run = no_git
            assert repo_services._git_branch(top) == "feature/x"
            (top / ".git" / "HEAD").write_text("0123456789abcdef\n", encoding="utf-8")
            assert repo_services._git_branch(top) == ""
            worktree = top / "wt"
            worktree.mkdir()
            (top / "gitdir").mkdir()
            (top / "gitdir" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
            (worktree / ".git").write_text(f"gitdir: {top / 'gitdir'}\n", encoding="utf-8")
            assert repo_services._git_branch(worktree) == "main"
        unified = (ROOT / "app/unified_control.py").read_text(encoding="utf-8")
        assert "git_repo_info(directory)" in unified and '"status", "--porcelain' not in unified

        runtime_v3 = (ROOT / "app/runtime_v3.py").read_text(encoding="utf-8")
        assert "snapshot = git_snapshot(directory)" in runtime_v3
        assert "include_repo=False" in runtime_v3
        assert "snapshot=snapshot" in runtime_v3
        guard = (ROOT / "config/plugins/server-runtime-guard.js").read_text(encoding="utf-8")
        assert "CONTEXT_HOT_PATH_WAIT_MS" in guard
        assert "refreshManagedContext" in guard
        # Store/maintenance/index regressions live in their own suite; run it
        # here so the existing verify-runtime-v3.sh gate covers them.
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/runtime-perf-regression.py")],
            check=True,
            timeout=600,
        )
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

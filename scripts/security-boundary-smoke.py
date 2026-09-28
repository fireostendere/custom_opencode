#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

os.environ["OPENCODE_REPO_EMBEDDINGS"] = "hash"

from repo_services import ArtifactStore, RepoIndexer, VerificationPipeline
from runtime_store import RuntimeStore
from runtime_v3 import SemanticRepoIndexer

with tempfile.TemporaryDirectory() as temp:
    temp_root = Path(temp)
    project = temp_root / "repo"
    project.mkdir()
    outside_py = temp_root / "outside-secret.py"
    outside_manifest = temp_root / "outside-package.json"
    marker = "CUSTOM_OPENCODE_OUTSIDE_SECRET_7C91"
    outside_py.write_text(f"def {marker}():\n    return 1\n", encoding="utf-8")
    outside_manifest.write_text(json.dumps({"scripts": {"test": f"echo {marker}"}}), encoding="utf-8")

    subprocess.run(["git", "init", "-q", str(project)], check=True)
    (project / "escape.py").symlink_to(outside_py)
    (project / "package.json").symlink_to(outside_manifest)
    subprocess.run(["git", "-C", str(project), "add", "escape.py", "package.json"], check=True)

    store = RuntimeStore(temp_root / "state" / "runtime.sqlite3")
    store.initialize()

    legacy_index = RepoIndexer(store).refresh(str(project), force=True)
    legacy_blob = json.dumps(legacy_index, ensure_ascii=False)
    assert marker not in legacy_blob, "RepoIndexer followed a tracked symlink outside the repository"

    semantic_index = SemanticRepoIndexer(store).refresh(str(project), force=True)
    semantic_blob = json.dumps(semantic_index, ensure_ascii=False)
    assert marker not in semantic_blob, "SemanticRepoIndexer followed a tracked symlink outside the repository"

    task = store.create_task(
        session_id="security-boundary",
        project_dir=str(project),
        text="verify",
        profile="build",
    )
    pipeline = VerificationPipeline(ArtifactStore(store))

    old_mode = os.environ.get("OPENCODE_VERIFY_PIPELINE")
    old_trust = os.environ.get("OPENCODE_VERIFY_TRUST_REPO")
    try:
        os.environ["OPENCODE_VERIFY_PIPELINE"] = "auto"
        os.environ.pop("OPENCODE_VERIFY_TRUST_REPO", None)
        result = pipeline.run(task=task)
        assert result["enabled"] is False
        assert result["ok"] is True
        assert "trust" in str(result.get("reason", "")).lower()

        os.environ["OPENCODE_VERIFY_TRUST_REPO"] = "1"
        discovered = pipeline.discover(str(project))
        assert discovered == [], "verifier followed an external package.json symlink"
    finally:
        if old_mode is None:
            os.environ.pop("OPENCODE_VERIFY_PIPELINE", None)
        else:
            os.environ["OPENCODE_VERIFY_PIPELINE"] = old_mode
        if old_trust is None:
            os.environ.pop("OPENCODE_VERIFY_TRUST_REPO", None)
        else:
            os.environ["OPENCODE_VERIFY_TRUST_REPO"] = old_trust

print("Security boundary smoke passed: repo symlinks blocked + verifier requires explicit trust")

# ---- Server-side git hardening: repository config must not run programs ----
# A pre-existing command-scope entry must survive the hardening (appended).
for key in [name for name in os.environ if name.startswith("GIT_CONFIG_")]:
    os.environ.pop(key)
os.environ.update({
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "user.name",
    "GIT_CONFIG_VALUE_0": "Boundary Smoke",
    "GIT_CONFIG_NOSYSTEM": "1",
})
with tempfile.TemporaryDirectory() as temp:
    temp_root = Path(temp)
    os.environ.setdefault("OPENCODE_SERVER_PASSWORD", "boundary-test")
    os.environ.setdefault("OPENCODE_BACKEND_URL", "http://127.0.0.1:9")
    os.environ.setdefault("OPENCODE_BACKEND_PASSWORD", "boundary-test")
    os.environ["OPENCODE_SCRATCH_DIRECTORY"] = str(temp_root / "scratch")
    os.environ["OPENCODE_PROJECT_ROOTS"] = str(temp_root)
    os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(temp_root / "state" / "features.json")

    marker = temp_root / "executed.log"
    evil = temp_root / "evil.sh"
    evil.write_text(f"#!/bin/sh\necho \"$0 $*\" >> '{marker}'\nexit 0\n", encoding="utf-8")
    evil.chmod(0o755)
    repo = temp_root / "hostile"

    def git(*args: str, env: dict[str, str] | None = None, check: bool = True, **kwargs):
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env, check=check, **kwargs)

    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    git("config", "user.email", "boundary@example.invalid")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    git("add", "a.txt")
    git("commit", "-qm", "base")
    # What an agent could write into .git/config and .git/hooks.
    git("config", "core.fsmonitor", str(evil))
    git("config", "log.showSignature", "true")
    git("config", "gpg.program", str(evil))
    hook = repo / ".git" / "hooks" / "post-checkout"
    hook.write_text(f"#!/bin/sh\necho post-checkout >> '{marker}'\n", encoding="utf-8")
    hook.chmod(0o755)
    tree = git("rev-parse", "HEAD^{tree}").stdout.strip()
    parent = git("rev-parse", "HEAD").stdout.strip()
    signed = git(
        "hash-object", "-t", "commit", "-w", "--stdin",
        input=f"tree {tree}\nparent {parent}\nauthor B <b@example.invalid> 1700000000 +0000\n"
              f"committer B <b@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n"
              f" -----END PGP SIGNATURE-----\n\nsigned\n",
    ).stdout.strip()
    git("update-ref", "refs/heads/signed", signed)
    (repo / "a.txt").write_text("changed\n", encoding="utf-8")

    def exercise(env: dict[str, str] | None, tag: str) -> list[str]:
        marker.unlink(missing_ok=True)
        for args in (
            ["status", "--porcelain"],
            ["ls-files", "--others", "--exclude-standard"],
            ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
            ["diff-files", "--name-only"],
            ["log", "--all", "--max-count=5", "--pretty=format:%H"],
            ["worktree", "add", "--detach", str(temp_root / f"worktree-{tag}"), "HEAD"],
        ):
            git(*args, env=env, check=False)
        return marker.read_text(encoding="utf-8").splitlines() if marker.exists() else []

    control = exercise(dict(os.environ), "control")
    assert any("evil.sh" in line for line in control) and "post-checkout" in control, control

    import server  # noqa: E402  (hardens os.environ at import time)

    assert os.environ["GIT_CONFIG_KEY_0"] == "user.name" and os.environ["GIT_CONFIG_VALUE_0"] == "Boundary Smoke"
    assert os.environ["GIT_TERMINAL_PROMPT"] == "0"
    hardened = exercise(None, "hardened")  # children inherit os.environ
    assert hardened == [], f"repository config/hook executed despite hardening: {hardened}"
    assert git("config", "user.name").stdout.strip() == "Boundary Smoke", "pre-existing GIT_CONFIG entry lost"

    # Idempotent; a malformed inherited list is replaced instead of breaking git.
    snapshot = dict(os.environ)
    assert server.harden_git_environment() == {} and dict(os.environ) == snapshot
    malformed = {"GIT_CONFIG_COUNT": "3", "GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "x"}
    undo = server.harden_git_environment(malformed)
    assert malformed["GIT_CONFIG_COUNT"] == str(len(server.GIT_HARDENING))
    assert malformed["GIT_CONFIG_KEY_0"] == "core.fsmonitor" and undo["GIT_CONFIG_KEY_0"] == "user.name"
    # The backend service restart helper must not inherit the hardening.
    restored = {**os.environ}
    for name, value in server.GIT_HARDENING_UNDO.items():
        if value is None:
            restored.pop(name, None)
        else:
            restored[name] = value
    assert restored.get("GIT_CONFIG_COUNT") == "1" and "GIT_CONFIG_KEY_1" not in restored

    # ---- git revert: only files Git lists as untracked, inside a work tree ----
    import server_features  # noqa: E402

    project = temp_root / "project"
    (project / "sub").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(["git", "-C", str(project), "config", "user.email", "boundary@example.invalid"], check=True)
    (project / ".gitignore").write_text(".env\nbuild/\n", encoding="utf-8")
    (project / "tracked.txt").write_text("base\n", encoding="utf-8")
    (project / "sub" / "nested.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)
    (project / ".env").write_text("SECRET=keep\n", encoding="utf-8")
    (project / "new.txt").write_text("untracked\n", encoding="utf-8")
    (project / "*").write_text("literal star\n", encoding="utf-8")
    outside_secret = temp_root / "outside-secret.txt"
    outside_secret.write_text("keep\n", encoding="utf-8")
    (project / "escape-link").symlink_to(outside_secret)
    (project / "dir-link").symlink_to(temp_root / "not-a-repo", target_is_directory=True)
    not_repo = temp_root / "not-a-repo"
    not_repo.mkdir()
    (not_repo / "precious.txt").write_text("keep\n", encoding="utf-8")

    def revert(directory: Path, path: str, **extra: str) -> dict:
        return server_features.git_revert({"directory": str(directory), "path": path, "mode": "file", **extra})

    def refused(directory: Path, path: str, **extra: str) -> None:
        try:
            revert(directory, path, **extra)
        except ValueError:
            return
        raise AssertionError(f"git revert accepted {directory}/{path}")

    # The reported deletion: a directory outside any repository.
    refused(temp_root, "not-a-repo/precious.txt")
    refused(not_repo, "precious.txt")
    assert (not_repo / "precious.txt").exists()
    # Ignored files (.env), symlinks, git metadata and traversal survive.
    refused(project, ".env")
    assert (project / ".env").read_text(encoding="utf-8") == "SECRET=keep\n"
    refused(project, "escape-link")
    assert (project / "escape-link").is_symlink() and outside_secret.exists()
    refused(project, "dir-link/precious.txt")
    assert (not_repo / "precious.txt").exists()
    for bad in (".git/config", ".git/HEAD", ".gitattributes", "sub/../../outside-secret.txt", "../outside-secret.txt", "/etc/passwd", "sub/", "sub"):
        refused(project, bad)
    assert (project / ".git" / "config").exists() and outside_secret.exists()
    # A literal "*" never expands to other files.
    assert revert(project, "*")["action"] == "removed-untracked"
    assert not (project / "*").exists() and (project / "new.txt").exists() and (project / "tracked.txt").exists()
    # Untracked, non-ignored files are removed; tracked files are restored.
    assert revert(project, "new.txt")["action"] == "removed-untracked" and not (project / "new.txt").exists()
    (project / "tracked.txt").write_text("changed\n", encoding="utf-8")
    assert revert(project, "tracked.txt")["action"] == "restored"
    assert (project / "tracked.txt").read_text(encoding="utf-8") == "base\n"
    # A session rooted in a subdirectory uses paths relative to itself.
    (project / "sub" / "nested.txt").write_text("one\nTWO\nthree\n", encoding="utf-8")
    assert revert(project / "sub", "nested.txt")["action"] == "restored"
    assert (project / "sub" / "nested.txt").read_text(encoding="utf-8") == "one\ntwo\nthree\n"
    (project / "sub" / "nested.txt").write_text("one\nTWO\nthree\n", encoding="utf-8")
    patch = subprocess.run(
        ["git", "-C", str(project / "sub"), "diff", "--no-ext-diff", "--relative", "--", "nested.txt"],
        capture_output=True, text=True, check=True,
    ).stdout
    hunk = server_features.git_revert({"directory": str(project / "sub"), "path": "nested.txt", "mode": "hunk", "patch": patch})
    assert hunk["ok"] is True and (project / "sub" / "nested.txt").read_text(encoding="utf-8") == "one\ntwo\nthree\n"
    for hostile_patch in (
        patch.replace("a/nested.txt", "a/../tracked.txt"),
        "diff --git a/nested.txt b/nested.txt\nrename from nested.txt\nrename to evil.txt\n",
        "diff --git a/nested.txt b/nested.txt\nnew file mode 120000\n",
    ):
        try:
            server_features.git_revert({"directory": str(project / "sub"), "path": "nested.txt", "mode": "hunk", "patch": hostile_patch})
        except ValueError:
            pass
        else:
            raise AssertionError(f"hostile patch accepted: {hostile_patch!r}")

print("Security boundary smoke passed: git config/hooks/gpg neutralized for server-side git + git revert limited to untracked work-tree files")

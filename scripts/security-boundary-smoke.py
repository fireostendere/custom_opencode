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
#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    project = root / "project"
    project.mkdir()
    build = project / "build"
    build.mkdir()
    for index in range(7):
        (build / f"generated-{index}.txt").write_text("x", encoding="utf-8")
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(root / "runtime.sqlite3")
    os.environ["OPENCODE_SERVER_PASSWORD"] = "test-runtime"

    from runtime_store import RuntimeStore
    import runtime_completion
    import runtime_v3

    preview = runtime_completion.permission_preview(
        {"action": "shell", "resources": ["rm -rf build"]}, str(project)
    )
    assert preview.startswith("Удалить 7 объектов"), preview
    assert "build/" in preview, preview
    write_preview = runtime_completion.permission_preview(
        {"action": "write", "resources": ["build/a", "build/b"]}, str(project)
    )
    assert "2 файла" in write_preview and "build/" in write_preview, write_preview
    store = RuntimeStore(root / "runtime.sqlite3")
    store.initialize()
    runtime = SimpleNamespace(STORE=store, _usage_stage=lambda task: "implementation")
    control = SimpleNamespace(
        decision_for=lambda request, directory: {"risk": "R3", "reason": "test"}
    )
    features = SimpleNamespace()
    runtime_completion.install(runtime, runtime_v3, control, features)
    assert (
        runtime._usage_stage({"kind": "verification-fix", "metadata": {"repairOf": "t0"}})
        == "verification_fix"
    )
    assert runtime._usage_stage({"kind": "recovery", "metadata": {}}) == "recovery"
    assert (
        runtime._usage_stage(
            {"kind": "prompt", "metadata": {"avoidableWasteReason": "duplicate accepted request"}}
        )
        == "wasted_retries"
    )
    assert runtime._usage_stage({"kind": "prompt", "metadata": {}}) == "implementation"
    decision = control.decision_for(
        {"action": "shell", "resources": ["rm -rf build"]}, str(project)
    )
    assert decision["preview"].startswith("Удалить 7 объектов") and "build/" in decision["preview"]

print(
    "Runtime completion smoke passed: semantic permission preview + wasted retries"
)

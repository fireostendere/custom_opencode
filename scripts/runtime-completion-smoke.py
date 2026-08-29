#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import tempfile
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0,str(ROOT/"app"))

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp); project=root/"project"; project.mkdir(); build=project/"build"; build.mkdir()
    for index in range(7): (build/f"generated-{index}.txt").write_text("x",encoding="utf-8")
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"]=str(root/"runtime.sqlite3")
    os.environ["OPENCODE_SERVER_PASSWORD"]="test-runtime"

    from runtime_store import RuntimeStore
    import runtime_completion
    import runtime_v3

    preview=runtime_completion.permission_preview({"action":"shell","resources":["rm -rf build"]},str(project))
    assert preview.startswith("Удалить 7 объектов"),preview
    write_preview=runtime_completion.permission_preview({"action":"write","resources":["build/a","build/b"]},str(project))
    assert "2 файла" in write_preview and "build/" in write_preview,write_preview
    assert runtime_completion._cacheable("read",{"path":"README.md"})
    assert runtime_completion._cacheable("shell",{"command":"git status --short"})
    assert not runtime_completion._cacheable("shell",{"command":"git status; rm -rf build"})

    store=RuntimeStore(root/"runtime.sqlite3"); store.initialize()
    runtime=SimpleNamespace(STORE=store,_usage_stage=lambda task:"implementation")
    control=SimpleNamespace(decision_for=lambda request,directory:{"risk":"R3","reason":"test"})
    features=SimpleNamespace()
    runtime_completion.install(runtime,runtime_v3,control,features)
    assert runtime._usage_stage({"kind":"verification-fix","metadata":{"repairOf":"t0"}})=="wasted_retries"
    assert runtime._usage_stage({"kind":"prompt","metadata":{}})=="implementation"
    decision=control.decision_for({"action":"shell","resources":["rm -rf build"]},str(project))
    assert decision["preview"].startswith("Удалить 7 объектов")

    source=store.create_task(task_id="source-task",session_id="source",project_dir=str(project),text="source")
    store.checkpoint(source["id"],"implementation",summary="implemented alpha",data={"files":["a.py"]})
    target=store.create_task(task_id="target-task",session_id="target",project_dir=str(project),text="target")

    class FakeFeatures:
        @staticmethod
        def _data(value): return value
        @staticmethod
        def _backend_request_json(method,target,payload=None,timeout=20.0):
            if method=="POST" and target.endswith("/fork"): return {"id":"forked"}
            raise RuntimeError((method,target,payload))

    branches=runtime_v3.BranchStateService(store)
    merged=branches.merge(FakeFeatures(),"source","target",include_state=True)
    assert merged["mergedAgentState"]>=1
    inbox=store.mailbox_receive(target["id"])
    assert inbox and inbox[0]["type"]=="handoff"
    assert store.checkpoints(target["id"])[0]["stage"]=="branch-state-merged"

print("Runtime completion smoke passed: permission preview + safe pre-exec cache policy + wasted retries + branch-state handoff")

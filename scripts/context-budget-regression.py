#!/usr/bin/env python3
"""Adaptive context budget regression (merged onto the astra2 native-first architecture).

Guards:
- the universal 48000-token working-budget cap is gone; real model limit, user policy
  max and the session working budget remain three distinct limits;
- token accounting is native-first: an owned native hook supplies the authoritative
  count, otherwise a conservative explicit chars/2.2 estimate is used;
- budget requests are bounded by the real ceiling and max expansion steps, persist per
  session across restarts, never leak across sessions and never switch the selected model;
- auto-expansion happens only when policy allows it, in bounded steps, with compaction
  remaining the fallback that protects the real limit;
- POST /internal/runtime/context-budget requires the plugin token and wires the
  status/request actions with strict validation.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"app"))

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp); db=root/"state"/"runtime.sqlite3"
    os.environ["CUSTOM_OPENCODE_RUNTIME_DB"]=str(db)
    os.environ["OPENCODE_REPO_EMBEDDINGS"]="hash"
    for name in ("OPENCODE_CONTEXT_BUDGET_MAX","OPENCODE_CONTEXT_AUTO_EXPAND","OPENCODE_CONTEXT_MAX_STEPS",
                 "OPENCODE_CONTEXT_BUDGET_STEP","OPENCODE_RUNTIME_PLUGIN_TOKEN"):
        os.environ.pop(name,None)

    from model_registry import CapabilityRegistry
    from runtime_store import RuntimeStore
    from repo_services import ArtifactStore
    import runtime_v3
    from runtime_v3 import DynamicContextManager, SemanticRepoIndexer, SharedRAGService

    store=RuntimeStore(db); store.initialize(); project=root/"project"; project.mkdir()
    registry=CapabilityRegistry([
        {"providerID":"bailian-cli","id":"qwen3.8-max","name":"Qwen3.8 Max","capabilities":{"tools":True,"input":["text"]},"limit":{"context":983616}},
        {"providerID":"bailian-cli","id":"qwen3.7-plus","name":"Qwen3.7 Plus","capabilities":{"tools":True,"input":["text"]},"limit":{"context":1000000}},
    ])
    REF="bailian-cli/qwen3.8-max"

    class FakeFeatures:
        def __init__(self,context_rows=None,native=False,native_tokens=0):
            self.calls=[]
            self.context_rows=context_rows if context_rows is not None else [{"type":"message","text":"z"*44000}]
            self.snapshot={}
            if native:
                self.native_compaction_owned=True
                self.native_context_tokens=native_tokens
        def _session_directory(self,sid): return str(project)
        def _canonical_directory(self,value): return str(Path(value).resolve())
        @staticmethod
        def _data(value): return value.get("data") if isinstance(value,dict) and "data" in value else value
        def _backend_request_json(self,method,target,payload=None,timeout=20.0):
            self.calls.append((method,target,payload))
            if target.endswith("/context") and method=="GET": return self.context_rows
            if target.endswith("/compact") and method=="POST": return {"ok":True}
            if target.endswith("/summarize") and method=="POST": return {"ok":True}
            raise RuntimeError((method,target,payload))

    def make_runtime(policy=None,st=None):
        st=st or store
        return SimpleNamespace(
            REGISTRY=SimpleNamespace(
                profiles=lambda:{"direct":{"contextPolicy":policy or {"mode":"model-aware","targetRatio":.72}}},
                get=registry.get),
            STORE=st, ARTIFACTS=ArtifactStore(st))
    def make_task(sid,selected=REF):
        return store.create_task(session_id=sid,project_dir=str(project),text="budget probe",profile="direct",route={"selectedModel":selected})
    def est(rows): return max(1,int(len(json.dumps(rows,ensure_ascii=False,default=str))/2.2))
    def rows_for(tokens): return [{"type":"message","text":"z"*int(2.2*tokens)}]

    rt=make_runtime()
    manager=DynamicContextManager(store,SemanticRepoIndexer(store),SharedRAGService(store))
    LIMIT=983616; RESERVE=int(LIMIT*.12); HARD=LIMIT-RESERVE; BASE=int(LIMIT*.72)
    STATUS_SURFACE={"sessionID","usedTokens","usedSource","workingTokens","baseTokens","ceilingTokens",
                    "modelLimitTokens","reserveTokens","policyMaxTokens","model","autoExpand","stepsTaken",
                    "maxSteps","expandable","headroomTokens","requestedTokens","grantedAt"}

    # 1. Regression: no universal 48k cap; three limits stay distinct; full status surface.
    make_task("s-cap")
    st=manager.budget_status(FakeFeatures(),rt,"s-cap")
    assert STATUS_SURFACE<=set(st), STATUS_SURFACE-set(st)
    assert st["modelLimitTokens"]==LIMIT and st["reserveTokens"]==RESERVE, st
    assert st["baseTokens"]==BASE and st["baseTokens"]>48000, f"legacy 48k cap leaked: {st}"
    assert st["ceilingTokens"]==HARD and st["policyMaxTokens"] is None, st
    assert st["workingTokens"]==st["baseTokens"] and st["sessionID"]=="s-cap", st
    assert st["usedSource"]=="estimate" and st["expandable"] is True and st["model"]==REF, st
    assert st["stepsTaken"]==0 and st["maxSteps"]==4 and st["grantedAt"]==0 and st["requestedTokens"] is None, st
    assert st["headroomTokens"]==max(0,st["workingTokens"]-st["usedTokens"]), st

    # 2. User policy max (env and per-profile) only lowers the real ceiling; ratio clamps to [0.1,0.95].
    os.environ["OPENCODE_CONTEXT_BUDGET_MAX"]="100000"
    st=manager.budget_status(FakeFeatures(),rt,"s-cap")
    assert st["policyMaxTokens"]==100000 and st["ceilingTokens"]==100000, st
    assert st["baseTokens"]==100000 and st["workingTokens"]==100000, st
    os.environ.pop("OPENCODE_CONTEXT_BUDGET_MAX")
    st=manager.budget_status(FakeFeatures(),make_runtime({"targetRatio":.72,"maxBudgetTokens":64000}),"s-cap")
    assert st["ceilingTokens"]==64000 and st["workingTokens"]==64000 and st["baseTokens"]==64000, st
    st=manager.budget_status(FakeFeatures(),make_runtime({"targetRatio":5.0}),"s-cap")
    assert st["baseTokens"]==HARD and st["baseTokens"]<=LIMIT-st["reserveTokens"] and st["reserveTokens"]==RESERVE, st
    st=manager.budget_status(FakeFeatures(),make_runtime({"targetRatio":.001}),"s-cap")
    assert st["baseTokens"]==int(LIMIT*.1), st
    make_task("s-unknown",selected="ghost/model")
    st=manager.budget_status(FakeFeatures(),rt,"s-unknown")
    assert st["modelLimitTokens"]==32768 and st["ceilingTokens"]==32768-int(32768*.12), st
    assert st["workingTokens"]==int(32768*.72) and st["workingTokens"]<=st["ceilingTokens"], st

    # 3. Conservative explicit estimate when no native hook owns the session.
    rows=[{"type":"message","text":"z"*44000}]
    st=manager.budget_status(FakeFeatures(context_rows=rows),rt,"s-cap")
    assert st["usedSource"]=="estimate" and st["usedTokens"]==est(rows), st

    # 4. Native hook accounting wins over the JSON-length estimate.
    st=manager.budget_status(FakeFeatures(native=True,native_tokens=3650),rt,"s-cap")
    assert st["usedSource"]=="native" and st["usedTokens"]==3650, st

    # 5. Requests: bounded by max steps and ceiling, idempotent below working budget, strict on garbage.
    os.environ["OPENCODE_CONTEXT_MAX_STEPS"]="2"
    make_task("s-req")
    base=manager.budget_status(FakeFeatures(),rt,"s-req")["baseTokens"]
    assert base==BASE, base
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base+5000,"deeper analysis")
    assert {"granted","requestedTokens","deniedReason"}<=set(r), r
    assert r["granted"] is True and r["workingTokens"]==base+5000 and r["stepsTaken"]==1, r
    assert r["requestedTokens"]==base+5000 and r["deniedReason"] is None, r
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base+9000,"long file")
    assert r["granted"] is True and r["workingTokens"]==base+9000 and r["stepsTaken"]==2, r
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base+20000,"again")
    assert r["granted"] is False and r["workingTokens"]==base+9000 and "steps" in r["deniedReason"], r
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base,"already covered")
    assert r["granted"] is True and r["workingTokens"]==base+9000 and r["stepsTaken"]==2, r
    kinds={e["kind"] for e in store.events(session_id="s-req")}
    assert {"context.budget_granted","context.budget_denied"}<=kinds, kinds
    make_task("s-clamp")
    r=manager.budget_request(FakeFeatures(),rt,"s-clamp",10**9,"everything")
    assert r["granted"] is True and r["workingTokens"]==r["ceilingTokens"]==HARD, r
    r=manager.budget_request(FakeFeatures(),rt,"s-clamp",10**9,"more")
    assert r["granted"] is False and "ceiling" in r["deniedReason"], r
    for bad in (0,-5,"abc",None):
        try: manager.budget_request(FakeFeatures(),rt,"s-req",bad,"x"); raise AssertionError(f"tokens={bad!r} accepted")
        except ValueError: pass
    os.environ.pop("OPENCODE_CONTEXT_MAX_STEPS")

    # 6. Persistence across restarts and strict session isolation.
    store2=RuntimeStore(db); store2.initialize()
    mgr2=DynamicContextManager(store2,SemanticRepoIndexer(store2),SharedRAGService(store2))
    rt2=make_runtime(st=store2)
    st=mgr2.budget_status(FakeFeatures(),rt2,"s-req")
    assert st["workingTokens"]==base+9000 and st["stepsTaken"]==2, st
    make_task("s-fresh")
    st=mgr2.budget_status(FakeFeatures(),rt2,"s-fresh")
    assert st["workingTokens"]==st["baseTokens"]==base and st["stepsTaken"]==0, st

    # 7. Auto-expansion: only when allowed, bounded steps, compaction remains the fallback.
    COMPACT_SURFACE={"activeTokens","usedSource","budgetTokens","workingTokens","baseTokens","ceilingTokens",
                     "policyMaxTokens","autoExpanded","stepsTaken","maxSteps","reserveTokens","contextLimit",
                     "model","minGrowthTokens","growthTokens","compactionRequested","compactionPending",
                     "hasCompaction","compactionOwner","modelKnown","tokenEstimate"}
    os.environ["OPENCODE_CONTEXT_BUDGET_MAX"]="400000"; os.environ["OPENCODE_CONTEXT_AUTO_EXPAND"]="1"
    rt_auto=make_runtime({"targetRatio":.30})
    auto_base=int(LIMIT*.30); step=max(4000,min(64000,int(LIMIT*.05)))
    task_auto=make_task("s-auto")
    res=manager.maybe_compact(FakeFeatures(context_rows=rows_for(auto_base+500)),rt_auto,"s-auto",task_auto)
    assert COMPACT_SURFACE<=set(res), COMPACT_SURFACE-set(res)
    assert res["autoExpanded"] is True and res["workingTokens"]==res["budgetTokens"]==auto_base+step, res
    assert res["compactionRequested"] is False and res["stepsTaken"]==1, res
    assert res["baseTokens"]==auto_base and res["ceilingTokens"]==400000 and res["policyMaxTokens"]==400000, res
    assert res["usedSource"]=="estimate" and res["tokenEstimate"] is True, res
    assert res["compactionOwner"]=="runtime-monitor" and res["modelKnown"] is True, res
    assert "context.budget_expanded" in {e["kind"] for e in store.events(session_id="s-auto")}
    os.environ["OPENCODE_CONTEXT_MAX_STEPS"]="1"
    res=manager.maybe_compact(FakeFeatures(context_rows=rows_for(auto_base+step+5000)),rt_auto,"s-auto",task_auto)
    assert res["autoExpanded"] is False and res["workingTokens"]==auto_base+step, res
    assert res["compactionRequested"] is True, "steps exhausted -> compaction must still protect the real limit"
    assert "context.compaction_requested" in {e["kind"] for e in store.events(session_id="s-auto")}
    os.environ.pop("OPENCODE_CONTEXT_AUTO_EXPAND"); os.environ.pop("OPENCODE_CONTEXT_MAX_STEPS")
    os.environ["OPENCODE_CONTEXT_BUDGET_MAX"]="200000"
    task_off=make_task("s-noauto")
    res=manager.maybe_compact(FakeFeatures(context_rows=rows_for(205000)),rt,"s-noauto",task_off)
    assert res["autoExpanded"] is False and res["workingTokens"]==res["baseTokens"]==res["budgetTokens"]==200000, res
    assert res["compactionRequested"] is True and res["ceilingTokens"]==200000, res
    os.environ.pop("OPENCODE_CONTEXT_BUDGET_MAX")

    # 8. Budget operations never switch the selected model and only read session data.
    fake=FakeFeatures(); make_task("s-model")
    st=manager.budget_status(fake,rt,"s-model")
    r=manager.budget_request(fake,rt,"s-model",st["baseTokens"]+1000,"need more")
    st2=manager.budget_status(fake,rt,"s-model")
    assert st["model"]==REF and r["model"]==REF and st2["model"]==REF, (st["model"],r["model"],st2["model"])
    assert st2["workingTokens"]==st["baseTokens"]+1000, st2
    assert fake.calls and all(method=="GET" and target.endswith("/context") for method,target,_ in fake.calls), fake.calls

    # 9. Internal endpoint wiring: auth required, status/request/validation paths.
    os.environ["OPENCODE_RUNTIME_PLUGIN_TOKEN"]="test-runtime-token"
    rt_ep=make_runtime()
    class FakeHandler:
        def __init__(self,body,token="test-runtime-token"):
            self.headers={"X-OpenCode-Runtime":token,"Content-Length":str(len(body))}
            self.rfile=io.BytesIO(body); self.responses=[]; self.errors=[]
        def json_response(self,payload,status=200): self.responses.append((status,payload))
        def _feature_error(self,exc): self.errors.append(exc); self.json_response({"ok":False,"error":f"{type(exc).__name__}: {exc}"},status=400)
        def authenticated(self): return True
        def unauthorized(self): self.responses.append((401,{"ok":False}))
    def post(payload,token="test-runtime-token"):
        body=json.dumps(payload).encode()
        handler=FakeHandler(body,token)
        handled=runtime_v3.handle_post(handler,SimpleNamespace(path="/internal/runtime/context-budget"),rt_ep,FakeFeatures())
        assert handled is True
        return handler
    make_task("s-ep")
    handler=post({"sessionID":"s-ep","action":"status"})
    status,payload=handler.responses[-1]
    assert status==200 and payload["ok"] is True and payload["modelLimitTokens"]==LIMIT, payload
    assert payload["workingTokens"]==payload["baseTokens"]==BASE, payload
    handler=post({"sessionID":"s-ep","action":"request","tokens":750000,"reason":"long file analysis"})
    status,payload=handler.responses[-1]
    assert status==200 and payload["granted"] is True and payload["workingTokens"]==750000, payload
    handler=post({"sessionID":"s-ep","action":"bogus"})
    assert handler.responses[-1][0]==400 and handler.errors, handler.responses
    handler=post({"action":"status"})
    assert handler.responses[-1][0]==400, handler.responses
    handler=post({"sessionID":"s-ep","action":"status"},token="wrong-token")
    assert handler.responses[-1]==(403,{"ok":False,"error":"forbidden"}), handler.responses

print("Context budget regression passed: no 48k cap, distinct limits, native-first accounting, bounded persistent grants, wired endpoint")

#!/usr/bin/env python3
"""Adaptive context budget regression.

Guards:
- the universal 48000-token working-budget cap is gone (regression: legacy `_budget` clamped every model to 48k);
- real model limit, user policy max and session working budget remain three distinct limits;
- token accounting prefers provider usage and falls back to a conservative explicit estimate;
- budget requests are bounded by ceiling and max expansion steps, persist per session across restarts,
  never leak across sessions and never switch the selected model;
- auto-expansion happens only when policy allows it, in bounded steps, with compaction as the fallback;
- POST /internal/runtime/context-budget is authenticated and wired to status/request actions.
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
    for name in ("OPENCODE_CONTEXT_BUDGET_MAX","OPENCODE_CONTEXT_AUTO_EXPAND","OPENCODE_CONTEXT_MAX_STEPS"):
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

    class FakeFeatures:
        def __init__(self,context_rows=None,message_rows=None):
            self.calls=[]
            self.context_rows=context_rows if context_rows is not None else [{"type":"message","text":"z"*44000}]
            self.message_rows=message_rows if message_rows is not None else [{"info":{"role":"assistant"},"parts":[]}]
        def _session_directory(self,sid): return str(project)
        def _canonical_directory(self,value): return str(Path(value).resolve())
        @staticmethod
        def _data(value): return value.get("data") if isinstance(value,dict) and "data" in value else value
        def _backend_request_json(self,method,target,payload=None,timeout=20.0):
            self.calls.append((method,target,payload))
            if target.endswith("/context") and method=="GET": return self.context_rows
            if "/message" in target and method=="GET": return self.message_rows
            if target.endswith("/compact") and method=="POST": return {"ok":True}
            if target.endswith("/summarize") and method=="POST": return {"ok":True}
            raise RuntimeError((method,target,payload))

    def make_runtime(policy=None):
        return SimpleNamespace(
            REGISTRY=SimpleNamespace(
                profiles=lambda:{"direct":{"contextPolicy":policy or {"mode":"model-aware","targetRatio":.72}}},
                get=registry.get),
            CONTEXT=SimpleNamespace(envelope=lambda **kw:{"text":"","budgetChars":0,"usedChars":0,"omittedSections":0,"semanticDiff":None}),
            STORE=store, ARTIFACTS=ArtifactStore(store))
    def make_task(sid,selected="bailian-cli/qwen3.8-max"):
        return store.create_task(session_id=sid,project_dir=str(project),text="budget probe",profile="direct",route={"selectedModel":selected})

    rt=make_runtime()
    manager=DynamicContextManager(store,SemanticRepoIndexer(store),SharedRAGService(store))
    LIMIT=983616; RESERVE=max(16000,min(131072,int(LIMIT*.12))); HARD=LIMIT-RESERVE

    # 1. Regression: no universal 48k cap; three limits stay distinct.
    make_task("s-cap")
    st=manager.budget_status(FakeFeatures(),rt,"s-cap")
    assert st["modelLimitTokens"]==LIMIT, st
    assert st["baseTokens"]==int(LIMIT*.72) and st["baseTokens"]>48000, f"legacy 48k cap leaked: {st}"
    assert st["ceilingTokens"]==HARD, st
    assert st["policyMaxTokens"] is None and st["workingTokens"]==st["baseTokens"], st
    assert st["usedSource"] in {"provider","estimate"} and st["expandable"] is True, st

    # 2. User policy max: env and per-profile, always below the real hard limit.
    os.environ["OPENCODE_CONTEXT_BUDGET_MAX"]="100000"
    st=manager.budget_status(FakeFeatures(),rt,"s-cap")
    assert st["policyMaxTokens"]==100000 and st["ceilingTokens"]==100000 and st["workingTokens"]==100000, st
    os.environ.pop("OPENCODE_CONTEXT_BUDGET_MAX")
    rt_small=make_runtime({"targetRatio":.72,"maxBudgetTokens":64000})
    st=manager.budget_status(FakeFeatures(),rt_small,"s-cap")
    assert st["ceilingTokens"]==64000 and st["workingTokens"]==64000, st

    # 3. Real-limit protection survives ratio abuse and unknown models.
    rt_wide=make_runtime({"targetRatio":5.0})
    st=manager.budget_status(FakeFeatures(),rt_wide,"s-cap")
    assert st["baseTokens"]==int(LIMIT*.75) and st["baseTokens"]<=LIMIT-st["reserveTokens"] and st["reserveTokens"]>=16000, st
    make_task("s-unknown",selected="ghost/model")
    st=manager.budget_status(FakeFeatures(),rt,"s-unknown")
    assert st["modelLimitTokens"]==128000 and st["workingTokens"]<=128000-16000, st

    # 4. Conservative explicit estimate when provider usage is absent.
    rows=[{"type":"message","text":"z"*44000}]
    expected=max(1,int(len(json.dumps(rows,ensure_ascii=False,default=str))/2.0))
    st=manager.budget_status(FakeFeatures(context_rows=rows),rt,"s-cap")
    assert st["usedSource"]=="estimate" and st["usedTokens"]==expected, st
    assert expected>=int(len(json.dumps(rows))/2.2), "fallback must be conservative vs legacy chars/2.2"

    # 5. Provider usage wins over the JSON-length estimate.
    fake=FakeFeatures(message_rows=[
        {"info":{"role":"assistant","tokens":{"input":10,"output":5,"cache":{"read":1,"write":1}}}},
        {"info":{"role":"assistant","tokens":{"input":1200,"output":300,"reasoning":100,"cache":{"read":2000,"write":50}}}},
        {"info":{"role":"user"}},
    ])
    st=manager.budget_status(fake,rt,"s-cap")
    assert st["usedSource"]=="provider" and st["usedTokens"]==3650, st

    # 6. Requests: bounded by max steps, by ceiling, idempotent below working budget, strict on garbage.
    os.environ["OPENCODE_CONTEXT_MAX_STEPS"]="2"
    make_task("s-req")
    base=manager.budget_status(FakeFeatures(),rt,"s-req")["baseTokens"]
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base+5000,"deeper analysis")
    assert r["granted"] is True and r["workingTokens"]==base+5000 and r["stepsTaken"]==1, r
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base+9000,"long file")
    assert r["granted"] is True and r["workingTokens"]==base+9000 and r["stepsTaken"]==2, r
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base+20000,"again")
    assert r["granted"] is False and r["workingTokens"]==base+9000 and "steps" in r["deniedReason"], r
    r=manager.budget_request(FakeFeatures(),rt,"s-req",base,"already covered")
    assert r["granted"] is True and r["workingTokens"]==base+9000 and r["stepsTaken"]==2, r
    make_task("s-clamp")
    r=manager.budget_request(FakeFeatures(),rt,"s-clamp",10**9,"everything")
    assert r["granted"] is True and r["workingTokens"]==r["ceilingTokens"]==HARD, r
    r=manager.budget_request(FakeFeatures(),rt,"s-clamp",10**9,"more")
    assert r["granted"] is False and "ceiling" in r["deniedReason"], r
    for bad in (0,-5,"abc",None):
        try: manager.budget_request(FakeFeatures(),rt,"s-req",bad,"x"); raise AssertionError(f"tokens={bad!r} accepted")
        except ValueError: pass
    os.environ.pop("OPENCODE_CONTEXT_MAX_STEPS")

    # 7. Persistence across restarts and strict session isolation.
    store2=RuntimeStore(db)
    mgr2=DynamicContextManager(store2,SemanticRepoIndexer(store2),SharedRAGService(store2))
    rt2=make_runtime(); rt2.STORE=store2
    st=mgr2.budget_status(FakeFeatures(),rt2,"s-req")
    assert st["workingTokens"]==base+9000 and st["stepsTaken"]==2, st
    make_task("s-fresh")
    st=mgr2.budget_status(FakeFeatures(),rt2,"s-fresh")
    assert st["workingTokens"]==st["baseTokens"]==base and st["stepsTaken"]==0, st

    # 8. Auto-expansion: only when allowed, bounded steps, compaction remains the fallback.
    os.environ["OPENCODE_CONTEXT_BUDGET_MAX"]="400000"; os.environ["OPENCODE_CONTEXT_AUTO_EXPAND"]="1"
    rt_auto=make_runtime({"targetRatio":.30})
    auto_base=int(LIMIT*.30); step=max(4000,min(64000,int(LIMIT*.05)))
    task_auto=make_task("s-auto")
    rows_auto=[{"type":"message","text":"z"*(2*(auto_base+500))}]
    res=manager.maybe_compact(FakeFeatures(context_rows=rows_auto),rt_auto,"s-auto",task_auto)
    assert res["autoExpanded"] is True and res["workingTokens"]==auto_base+step, res
    assert res["compactionRequested"] is False and res["stepsTaken"]==1, res
    os.environ["OPENCODE_CONTEXT_MAX_STEPS"]="1"
    rows_over=[{"type":"message","text":"z"*(2*(auto_base+step+5000))}]
    res=manager.maybe_compact(FakeFeatures(context_rows=rows_over),rt_auto,"s-auto",task_auto)
    assert res["autoExpanded"] is False and res["workingTokens"]==auto_base+step, res
    assert res["compactionRequested"] is True, "steps exhausted -> compaction must still protect the real limit"
    os.environ.pop("OPENCODE_CONTEXT_AUTO_EXPAND"); os.environ.pop("OPENCODE_CONTEXT_MAX_STEPS")
    os.environ["OPENCODE_CONTEXT_BUDGET_MAX"]="200000"
    task_off=make_task("s-noauto")
    rows_noauto=[{"type":"message","text":"z"*(2*(200000+5000))}]
    res=manager.maybe_compact(FakeFeatures(context_rows=rows_noauto),rt,"s-noauto",task_off)
    assert res["autoExpanded"] is False and res["workingTokens"]==res["baseTokens"]==200000, res
    assert res["compactionRequested"] is True and res["budgetTokens"]==200000, res
    os.environ.pop("OPENCODE_CONTEXT_BUDGET_MAX")

    # 9. Budget operations never switch the selected model and only read session data.
    fake=FakeFeatures(); make_task("s-model")
    st=manager.budget_status(fake,rt,"s-model")
    manager.budget_request(fake,rt,"s-model",st["baseTokens"]+1000,"need more")
    assert st["model"]=="bailian-cli/qwen3.8-max", st
    assert fake.calls and all(method=="GET" for method,_,_ in fake.calls), fake.calls

    # 10. Internal endpoint wiring: auth required, status/request/validation paths.
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
    handler=post({"sessionID":"s-ep","action":"request","tokens":750000,"reason":"long file analysis"})
    status,payload=handler.responses[-1]
    assert status==200 and payload["granted"] is True and payload["workingTokens"]==750000, payload
    handler=post({"sessionID":"s-ep","action":"bogus"})
    assert handler.responses[-1][0]==400 and handler.errors, handler.responses
    handler=post({"action":"status"})
    assert handler.responses[-1][0]==400, handler.responses
    handler=post({"sessionID":"s-ep","action":"status"},token="wrong-token")
    assert handler.responses[-1]==(403,{"ok":False,"error":"forbidden"}), handler.responses

print("Context budget regression passed: no 48k cap, distinct limits, provider-first accounting, bounded persistent grants, wired endpoint")

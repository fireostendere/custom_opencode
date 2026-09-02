#!/usr/bin/env python3
"""Server runtime v2: durable tasks, provider-pinned routing, checkpoints and shared services.

This module is installed into server_features at process startup. It keeps the
existing /client-queue.json contract as a compatibility facade while replacing
its JSON FIFO with SQLite-backed tasks and a single worker loop.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from typing import Any
from urllib.parse import parse_qs, quote
from uuid import uuid4

from model_registry import CapabilityRegistry, ResourceScheduler
from repo_services import ArtifactStore, ContextService, RepoIndexer, SecretBroker, VerificationPipeline, git_snapshot, review_decision
from runtime_store import RuntimeStore, TASK_STATES, now_ms

STORE=RuntimeStore(); INDEXER=RepoIndexer(STORE); ARTIFACTS=ArtifactStore(STORE); CONTEXT=ContextService(STORE,INDEXER); VERIFY=VerificationPipeline(ARTIFACTS); SECRETS=SecretBroker(); SCHEDULER=ResourceScheduler(); REGISTRY=CapabilityRegistry([])
INSTALL_LOCK=threading.Lock(); INSTALLED=False; VERIFY_LOCK=threading.Lock(); VERIFYING:set[str]=set(); LAST_INDEX_AT:dict[str,float]={}; MIGRATION_DONE=False
PLAN_DIRECTORY=Path(os.environ.get("OPENCODE_PLAN_DIRECTORY") or (Path.home()/".opencode"/"plan")).expanduser(); PLAN_MAX_BYTES=1_000_000; PLAN_MAX_ITEMS=500
ACTIVE_STATES={"submitted","running","waiting_permission","verifying","recovering"}; QUEUE_STATES={"queued","blocked","paused"}
PROFILE_IDS={"direct","fast","build","architect","sol-orchestrated","sol-review","critical","research","review","long-horizon"}
PROFILE_ALIASES={"orchestrated":"architect","qwen3.8-orchestrated":"architect","gpt-5.6-sol-orchestrated":"sol-orchestrated"}


def _profile_id(value:Any)->str:
    profile=str(value or "direct")
    profile=PROFILE_ALIASES.get(profile,profile)
    if profile not in PROFILE_IDS: raise ValueError(f"unknown model profile: {value}")
    return profile


def _model_ref(session:dict[str,Any])->str|None:
    model=session.get("model")
    if isinstance(model,str): return model
    if isinstance(model,dict):
        provider=str(model.get("providerID") or model.get("provider") or ""); ident=str(model.get("id") or model.get("modelID") or ""); variant=str(model.get("variant") or "")
        return f"{provider}/{ident}"+(f"#{variant}" if variant else "") if provider and ident else None
    return None


def _mode(session:dict[str,Any])->str: return "plan" if "plan" in str(session.get("agent") or "build") else "build"


def _catalog(features:Any,directory:str)->list[dict[str,Any]]:
    key=hashlib.sha256(directory.encode()).hexdigest(); cached=STORE.cache_get("model-catalog",key)
    if isinstance(cached,list): return [item for item in cached if isinstance(item,dict)]
    try:
        value=features._data(features._backend_request_json("GET",features._workspace_target("/api/model",directory),timeout=12.0)); rows=[item for item in value if isinstance(item,dict)] if isinstance(value,list) else []
    except Exception: rows=[]
    STORE.cache_set("model-catalog",key,rows,ttl_seconds=30); return rows


def capability_snapshot(features:Any,directory:str)->dict[str,Any]: REGISTRY.refresh(_catalog(features,directory)); return REGISTRY.snapshot(stats_getter=STORE.model_stats)
def resource_snapshot()->dict[str,Any]: return SCHEDULER.snapshot(REGISTRY.profiles())


def _public(task:dict[str,Any])->dict[str,Any]:
    metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; route=task.get("route") if isinstance(task.get("route"),dict) else {}; verification=task.get("verification") if isinstance(task.get("verification"),dict) else {}
    return {"id":task.get("id"),"sessionID":task.get("session_id"),"projectDir":task.get("project_dir"),"kind":task.get("kind"),"profile":task.get("profile"),"priority":task.get("priority"),"state":task.get("state"),"text":str(task.get("text") or "")[:1000],"files":[str((item or {}).get("name") or "file") for item in (task.get("files") or []) if isinstance(item,dict)],"dependencies":task.get("dependencies") or [],"createdAt":task.get("created_at"),"updatedAt":task.get("updated_at"),"startedAt":task.get("started_at"),"finishedAt":task.get("finished_at"),"error":task.get("last_error"),"route":route,"verification":verification,"sandbox":metadata.get("sandbox"),"worktree":metadata.get("worktree")}


def _counts(tasks:list[dict[str,Any]])->dict[str,int]:
    out:dict[str,int]={}
    for task in tasks:
        state=str(task.get("state") or "unknown"); out[state]=out.get(state,0)+1
    return out


def queue_snapshot(session_id:str|None=None)->dict[str,Any]:
    if session_id:
        tasks=STORE.list_tasks(session_id=session_id,states=QUEUE_STATES,limit=200); items=[_public(task) for task in tasks]; errors=[task.get("last_error") for task in tasks if task.get("last_error")]
        return {"sessionID":session_id,"count":len(items),"items":items,"error":errors[-1] if errors else None}
    tasks=STORE.list_tasks(states=QUEUE_STATES,limit=1000); counts:dict[str,int]={}
    for task in tasks:
        sid=str(task.get("session_id") or ""); counts[sid]=counts.get(sid,0)+1
    return {"counts":counts,"total":sum(counts.values()),"states":_counts(tasks),"runtime":"sqlite-v2"}


def _usage_totals(features:Any,session_id:str)->dict[str,Any]:
    try: value=features._data(features._backend_request_json("GET",f"/api/session/{quote(session_id,safe='')}/message?limit=200",timeout=12.0))
    except Exception: return {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0.0,"signature":""}
    totals={"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0.0}; digest=[]
    for row in value if isinstance(value,list) else []:
        blob=row.get("info") if isinstance(row,dict) and isinstance(row.get("info"),dict) else row
        if not isinstance(blob,dict): continue
        tokens=blob.get("tokens") if isinstance(blob.get("tokens"),dict) else {}; cache=tokens.get("cache") if isinstance(tokens.get("cache"),dict) else {}
        for src,dst in (("input","input"),("output","output")):
            if isinstance(tokens.get(src),(int,float)): totals[dst]+=int(tokens[src])
        for src,dst in (("read","cacheRead"),("write","cacheWrite")):
            if isinstance(cache.get(src),(int,float)): totals[dst]+=int(cache[src])
        if isinstance(blob.get("cost"),(int,float)): totals["cost"]+=float(blob["cost"])
        digest.append(json.dumps(row,ensure_ascii=False,sort_keys=True,default=str)[-4000:])
    totals["signature"]=hashlib.sha256("\n".join(digest[-20:]).encode()).hexdigest()[:20] if digest else ""; return totals


def _last_assistant_text(features:Any,session_id:str)->str:
    try: value=features._data(features._backend_request_json("GET",f"/api/session/{quote(session_id,safe='')}/message?limit=80",timeout=10.0))
    except Exception: return ""
    for row in reversed(value if isinstance(value,list) else []):
        if not isinstance(row,dict): continue
        info=row.get("info") if isinstance(row.get("info"),dict) else row
        if not isinstance(info,dict) or info.get("role")!="assistant": continue
        parts=row.get("parts") if isinstance(row.get("parts"),list) else row.get("content") if isinstance(row.get("content"),list) else []; texts=[str(part.get("text") or "") for part in parts if isinstance(part,dict) and part.get("type")=="text"]
        if texts: return "\n".join(texts)[-16000:]
        if isinstance(row.get("text"),str): return row["text"][-16000:]
    return ""


def enqueue_prompt(features:Any,payload:dict[str,Any])->dict[str,Any]:
    sid=str(payload.get("sessionID") or "")
    if not sid or len(sid)>256: raise ValueError("invalid session id")
    directory=features._session_directory(sid); text=str(payload.get("text") or ""); files=payload.get("files") if isinstance(payload.get("files"),list) else []
    if not text.strip() and not files: raise ValueError("empty queue item")
    profile=_profile_id(payload.get("profile") or payload.get("modelProfile") or "direct"); session=features._session_info(sid); selected=_model_ref(session); REGISTRY.refresh(_catalog(features,directory)); profile_data=REGISTRY.profiles().get(profile,REGISTRY.profiles()["direct"]); decision=SCHEDULER.decide(profile_data,selected_model=selected)
    metadata={"selectedModelAtCreate":selected,"modeAtCreate":_mode(session),"usageBaseline":_usage_totals(features,sid),"sandbox":profile_data.get("sandbox","repo-write"),"handoff":payload.get("handoff") if isinstance(payload.get("handoff"),dict) else None}
    task=STORE.create_task(session_id=sid,project_dir=directory,text=text,files=files,profile=profile,priority=int(payload.get("priority") or 0),dependencies=[str(item) for item in (payload.get("dependencies") or []) if item],kind=str(payload.get("kind") or "prompt")[:80],metadata=metadata,baseline=git_snapshot(directory),route=decision.as_dict())
    STORE.checkpoint(task["id"],"queued",summary="Task persisted in server queue",data={"route":decision.as_dict(),"baseline":task.get("baseline")}); return {"ok":True,"item":_public(task),"task":_public(task),"count":queue_snapshot(sid)["count"]}


def delete_queue_item(session_id:str,item_id:str)->dict[str,Any]:
    task=STORE.get_task(item_id)
    if not task or task.get("session_id")!=session_id: return {"ok":False,"count":queue_snapshot(session_id)["count"]}
    if task.get("state") not in QUEUE_STATES: return {"ok":False,"count":queue_snapshot(session_id)["count"],"error":"task is not queued"}
    STORE.transition(item_id,"cancelled",event="task.cancelled",data={"source":"queue-delete"}); return {"ok":True,"count":queue_snapshot(session_id)["count"]}


def reorder_queue(session_id:str,ids:list[str])->dict[str,Any]: STORE.reorder(session_id,ids); return {"ok":True,"count":queue_snapshot(session_id)["count"]}


def _switch_session(features:Any,task:dict[str,Any])->dict[str,Any]:
    session=features._session_info(task["session_id"]); metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; mode=str(metadata.get("modeAtCreate") or _mode(session)); selected=_model_ref(session); profiles=REGISTRY.profiles(); profile_id=_profile_id(task.get("profile")); profile=profiles.get(profile_id)
    if not isinstance(profile,dict): raise ValueError(f"task profile is not configured: {profile_id}")
    role_task=task.get("kind") in {"review","research","aggregate"}
    decision=SCHEDULER.decide(profile,selected_model=selected); model=decision.selected_model
    # A native plan session must retain its selected model.  Agent and model are
    # independent V2 controls; changing both loses the caller's provider/variant.
    if (role_task or mode!="plan") and profile.get("route")!="selected" and model and model!=selected:
        provider,sep,remainder=model.partition("/"); ident,has_variant,variant=remainder.partition("#")
        if sep and provider and ident:
            pinned={"providerID":provider,"id":ident}
            if has_variant and variant: pinned["variant"]=variant
            features._backend_request_json("POST",f"/api/session/{quote(task['session_id'],safe='')}/model",{"model":pinned},timeout=12.0)
    agent=profile.get("agentPlan") if mode=="plan" else profile.get("agentBuild")
    if role_task: agent="plan-direct"
    if agent and agent!=str(session.get("agent") or ""):
        try: features._backend_request_json("POST",f"/api/session/{quote(task['session_id'],safe='')}/agent",{"agent":agent},timeout=12.0)
        except Exception: pass
    STORE.update_task(task["id"],route=decision.as_dict(),metadata_patch={"runtimeModel":model or selected,"runtimeAgent":agent}); return decision.as_dict()


def context_envelope(features:Any,session_id:str,project_instructions:str="")->dict[str,Any]:
    active=STORE.list_tasks(session_id=session_id,states=ACTIVE_STATES,limit=10); task=active[0] if active else None; directory=features._session_directory(session_id); return CONTEXT.envelope(project_dir=directory,task=task,project_instructions=project_instructions,budget_chars=48000)


def dispatch_immediate(features:Any,*,session_id:str,text:str,files:list[Any],profile:str="direct")->dict[str,Any]:
    created=enqueue_prompt(features,{"sessionID":session_id,"text":text,"files":files,"profile":profile,"priority":100,"kind":"prompt"}); task=STORE.get_task(created["task"]["id"])
    if not task: raise RuntimeError("task creation failed")
    result=_dispatch_task(features,task); return {"task":_public(STORE.get_task(task["id"]) or task),"result":result}


def _dispatch_task(features:Any,task:dict[str,Any])->Any:
    if task.get("state") not in {"queued","blocked"}: return None
    ready,waiting=STORE.dependency_state(task["id"])
    if not ready:
        if task.get("state")!="blocked": STORE.transition(task["id"],"blocked",event="task.blocked",data={"waitingFor":waiting})
        return None
    route=_switch_session(features,task); task=STORE.get_task(task["id"]) or task; STORE.transition(task["id"],"submitted",event="task.dispatched",data={"route":route}); STORE.checkpoint(task["id"],"dispatched",summary="Prompt accepted for dispatch",data={"route":route,"repo":git_snapshot(task["project_dir"])}); started=time.monotonic()
    try: result=features._send_backend_prompt(task["session_id"],str(task.get("text") or ""),list(task.get("files") or []))
    except Exception as exc:
        STORE.transition(task["id"],"failed",event="task.dispatch_failed",data={},error=f"{type(exc).__name__}: {exc}"); STORE.add_usage(task_id=task["id"],model_ref=(task.get("route") or {}).get("selectedModel"),stage=_usage_stage(task),latency_ms=int((time.monotonic()-started)*1000),success=False); raise
    STORE.update_task(task["id"],metadata_patch={"dispatchAcceptedAt":now_ms()}); return result


def _usage_stage(task:dict[str,Any])->str:
    kind=str(task.get("kind") or "prompt")
    if kind=="review": return "review"
    if kind=="research": return "research"
    if kind=="verification-fix": return "implementation"
    return "planning" if "plan" in str((task.get("metadata") or {}).get("modeAtCreate")) else "implementation" if kind=="prompt" else kind


def _capture_usage(features:Any,task:dict[str,Any],success:bool)->None:
    baseline=(task.get("metadata") or {}).get("usageBaseline") if isinstance(task.get("metadata"),dict) else {}; current=_usage_totals(features,task["session_id"])
    def delta(name:str)->float:
        try: return max(0.0,float(current.get(name,0))-float((baseline or {}).get(name,0) or 0))
        except (TypeError,ValueError): return 0.0
    route=task.get("route") if isinstance(task.get("route"),dict) else {}; STORE.add_usage(task_id=task["id"],model_ref=route.get("selectedModel"),stage=_usage_stage(task),input_tokens=int(delta("input")),output_tokens=int(delta("output")),cache_read_tokens=int(delta("cacheRead")),cache_write_tokens=int(delta("cacheWrite")),cost=delta("cost"),latency_ms=max(0,now_ms()-int(task.get("started_at") or task.get("created_at") or now_ms())),success=success)


def _tool_signatures(features:Any,sid:str)->list[str]:
    try: value=features._data(features._backend_request_json("GET",f"/api/session/{quote(sid,safe='')}/message?limit=60",timeout=8.0))
    except Exception: return []
    return re.findall(r'"(?:tool|toolName|name)"\s*:\s*"([A-Za-z0-9_.:-]+)"',json.dumps(value,ensure_ascii=False,sort_keys=True,default=str))[-12:]


def _interrupt(features:Any,sid:str)->None:
    q=quote(sid,safe="")
    try: features._backend_request_json("POST",f"/api/session/{q}/interrupt",{},timeout=10.0)
    except Exception: features._backend_request_json("POST",f"/api/session/{q}/abort",{},timeout=10.0)


def _permission_pending(features:Any,task:dict[str,Any])->bool:
    try: rows=features._permission_requests(task["project_dir"])
    except Exception: return False
    return any(str(item.get("sessionID") or item.get("sessionId") or "")==task["session_id"] for item in rows if isinstance(item,dict))


def _monitor_progress(features:Any,task:dict[str,Any])->None:
    current=_usage_totals(features,task["session_id"]); repo=git_snapshot(task["project_dir"]); signature=f"{current.get('signature')}:{repo.get('statusHash')}"; metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; old=str(metadata.get("progressSignature") or ""); repeats=int(metadata.get("progressRepeats") or 0); repeats=repeats+1 if signature and signature==old else 0
    if signature!=old: STORE.checkpoint(task["id"],"progress",summary="Agent progress changed",data={"messageSignature":current.get("signature"),"repo":repo})
    tools=_tool_signatures(features,task["session_id"]); loop=len(tools)>=6 and (tools[-3:]==tools[-6:-3] or len(set(tools[-5:]))==1); owner=str(metadata.get("ownershipRoot") or task["project_dir"]); conflicts=STORE.ownership_replace(owner,task["id"],repo.get("changed") or []); STORE.update_task(task["id"],metadata_patch={"progressSignature":signature,"progressRepeats":repeats,"lastTools":tools[-8:],"patchConflicts":conflicts})
    if loop and not metadata.get("loopReported"): STORE.event(kind="agent.loop_detected",task_id=task["id"],session_id=task["session_id"],project_dir=task["project_dir"],data={"tools":tools[-8:]}); STORE.update_task(task["id"],metadata_patch={"loopReported":True})
    if conflicts and not metadata.get("conflictReported"): STORE.event(kind="patch.conflict",task_id=task["id"],session_id=task["session_id"],project_dir=task["project_dir"],data={"conflicts":conflicts}); STORE.update_task(task["id"],metadata_patch={"conflictReported":True})
    threshold=int(os.environ.get("OPENCODE_STUCK_PROGRESS_POLLS","100"))
    if repeats>=threshold and not metadata.get("stuckReported"):
        STORE.event(kind="agent.stuck",task_id=task["id"],session_id=task["session_id"],project_dir=task["project_dir"],data={"repeats":repeats}); STORE.update_task(task["id"],metadata_patch={"stuckReported":True})
        if os.environ.get("OPENCODE_STUCK_ACTION","warn").strip().lower()=="interrupt":
            try: _interrupt(features,task["session_id"]); STORE.transition(task["id"],"paused",event="agent.stuck_paused",data={"repeats":repeats})
            except Exception: pass


def _finish_async(features:Any,task:dict[str,Any])->None:
    with VERIFY_LOCK:
        if task["id"] in VERIFYING: return
        VERIFYING.add(task["id"])
    threading.Thread(target=_verify_finish,args=(features,task["id"]),name=f"verify-{task['id'][:10]}",daemon=True).start()


def _verify_finish(features:Any,task_id:str)->None:
    try:
        task=STORE.get_task(task_id)
        if not task: return
        verification={"enabled":False,"results":[],"ok":True,"reason":"read-only task"} if task.get("kind") in {"research","review","aggregate"} else VERIFY.run(task=task); STORE.update_task(task_id,verification=verification); STORE.checkpoint(task_id,"verification",summary="Verification pipeline finished",data={"ok":verification.get("ok"),"results":verification.get("results",[])}); task=STORE.get_task(task_id) or task; actionable=verification.get("actionableFailures") if isinstance(verification,dict) else []; environment=verification.get("environmentFailures") if isinstance(verification,dict) else []; _capture_usage(features,task,not bool(actionable)); review=review_decision(task["project_dir"],task.get("baseline") if isinstance(task.get("baseline"),dict) else None); STORE.event(kind="review.decision",task_id=task_id,session_id=task["session_id"],project_dir=task["project_dir"],data=review)
        if actionable:
            STORE.transition(task_id,"needs_attention",event="verification.code_failure",data={"failures":actionable}); STORE.checkpoint(task_id,"needs_attention",summary="Code verification failed; only actionable failures are eligible for repair",data={"failures":actionable})
            if os.environ.get("OPENCODE_VERIFY_AUTOFIX","1").strip().lower() not in {"0","false","off","no"} and task.get("kind")!="verification-fix":
                failure="\n\n".join(str(item.get("failureSummary") or "") for item in actionable)[:12000]; STORE.create_task(session_id=task["session_id"],project_dir=task["project_dir"],text="Verification found code failures after the previous task. Fix only these failures, preserve the intended change, then finish.\n\n"+failure,files=[],profile=str(task.get("profile") or "build"),priority=int(task.get("priority") or 0)+5,kind="verification-fix",metadata={"repairOf":task_id,"modeAtCreate":"build","usageBaseline":_usage_totals(features,task["session_id"]),"sandbox":"repo-write"},baseline=git_snapshot(task["project_dir"]))
        else:
            STORE.transition(task_id,"completed",event="task.completed",data={"verificationWarnings":environment}); STORE.checkpoint(task_id,"completed",summary="Task completed and durable state committed",data={"repo":git_snapshot(task["project_dir"]),"verification":verification})
            if task.get("kind")=="research":
                target=(task.get("metadata") or {}).get("mailboxTo") if isinstance(task.get("metadata"),dict) else None
                if target: STORE.mailbox_send(project_dir=task["project_dir"],from_task=task_id,to_task=str(target),message_type="finding",payload={"text":_last_assistant_text(features,task["session_id"])[:14000],"route":task.get("route")})
            profile=REGISTRY.profiles().get(str(task.get("profile")),REGISTRY.profiles()["direct"])
            if task.get("kind") in {"prompt","verification-fix"} and profile.get("autoReview") and review.get("needed") and os.environ.get("OPENCODE_AUTO_REVIEW","smart").strip().lower() in {"smart","enqueue","1","true"}:
                existing=[item for item in STORE.list_tasks(session_id=task["session_id"],limit=200) if (item.get("metadata") or {}).get("reviewOf")==task_id]
                if not existing:
                    review_profile = "sol-review" if task.get("profile") == "sol-orchestrated" else "review"
                    STORE.create_task(session_id=task["session_id"],project_dir=task["project_dir"],text="Review the changes produced by the previous task. Focus on correctness, regressions, security and missing tests. Do not edit files; return concise findings.",files=[],profile=review_profile,priority=int(task.get("priority") or 0)-5,kind="review",metadata={"reviewOf":task_id,"modeAtCreate":"plan","usageBaseline":_usage_totals(features,task["session_id"]),"sandbox":"safe"},baseline=task.get("baseline") if isinstance(task.get("baseline"),dict) else git_snapshot(task["project_dir"]))
    except Exception as exc:
        try: STORE.transition(task_id,"failed",event="task.finalize_failed",data={},error=f"{type(exc).__name__}: {exc}")
        except Exception: pass
    finally:
        with VERIFY_LOCK: VERIFYING.discard(task_id)


def _monitor_active(features:Any,statuses:dict[str,Any])->None:
    current=now_ms()
    for task in STORE.list_tasks(states=ACTIVE_STATES,limit=500):
        busy=features._status_busy(statuses.get(task["session_id"])); state=str(task.get("state"))
        if state=="recovering": STORE.transition(task["id"],"running" if busy else "paused",event="task.recovered_attached" if busy else "task.recovery_paused",data={}); continue
        if state=="verifying": continue
        pending=_permission_pending(features,task)
        if pending and state!="waiting_permission": STORE.transition(task["id"],"waiting_permission",event="task.waiting_permission",data={}); STORE.checkpoint(task["id"],"waiting_permission",summary="Agent is waiting for a permission decision",data={}); continue
        if state=="waiting_permission" and not pending: STORE.transition(task["id"],"running" if busy else "submitted",event="task.permission_resolved",data={}); state="running" if busy else "submitted"
        if busy:
            if state=="submitted": STORE.transition(task["id"],"running",event="task.running",data={})
            metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; last=int(metadata.get("progressCheckedAt") or 0)
            if current-last>7000: STORE.update_task(task["id"],metadata_patch={"progressCheckedAt":current}); _monitor_progress(features,STORE.get_task(task["id"]) or task)
            continue
        started=int(task.get("started_at") or 0); accepted=int((task.get("metadata") or {}).get("dispatchAcceptedAt") or 0) if isinstance(task.get("metadata"),dict) else 0
        if state in {"submitted","running"} and current-max(started,accepted)>2500: STORE.transition(task["id"],"verifying",event="task.agent_idle",data={}); _finish_async(features,STORE.get_task(task["id"]) or task)


def _dispatch_ready(features:Any,statuses:dict[str,Any])->None:
    queued=STORE.list_tasks(states=["queued","blocked"],limit=500)
    for sid in sorted({str(task["session_id"]) for task in queued}):
        if features._status_busy(statuses.get(sid)) or STORE.list_tasks(session_id=sid,states=ACTIVE_STATES,limit=1): continue
        task=STORE.next_ready(session_id=sid)
        if task:
            try: _dispatch_task(features,task)
            except Exception: pass


def _migrate(features:Any)->None:
    global MIGRATION_DONE
    if MIGRATION_DONE: return
    try:
        with features.STATE_LOCK:
            state=features._load_state_unlocked(); queues=state.get("queues") if isinstance(state.get("queues"),dict) else {}; imported=0
            if not queues: MIGRATION_DONE=True; return
            for sid,rows in list(queues.items()):
                if not isinstance(rows,list): continue
                try: directory=features._session_directory(str(sid))
                except Exception: continue
                for row in rows:
                    if not isinstance(row,dict): continue
                    legacy=str(row.get("id") or "")
                    if legacy and STORE.get_task(legacy): continue
                    STORE.create_task(session_id=str(sid),project_dir=directory,text=str(row.get("text") or ""),files=list(row.get("files") or []),profile=_profile_id(row.get("profile")),kind="prompt",metadata={"migratedFrom":"web-features-v1","modeAtCreate":"build","usageBaseline":_usage_totals(features,str(sid))},baseline=git_snapshot(directory),task_id=legacy if legacy.startswith("q_") else None); imported+=1
                queues.pop(sid,None)
            if imported: state["queues"]=queues; features._save_state_unlocked(state); STORE.event(kind="runtime.legacy_queue_migrated",data={"items":imported})
            MIGRATION_DONE=True
    except Exception: pass


def _refresh_indexes()->None:
    projects=sorted({str(task.get("project_dir") or "") for task in STORE.list_tasks(states=ACTIVE_STATES|QUEUE_STATES,limit=500) if task.get("project_dir")}); current=time.monotonic()
    for directory in projects[:30]:
        if current-LAST_INDEX_AT.get(directory,0.0)<30.0: continue
        LAST_INDEX_AT[directory]=current
        try: INDEXER.refresh(directory)
        except Exception: pass


def worker(features:Any)->None:
    while True:
        try:
            _migrate(features); active=STORE.list_tasks(states=ACTIVE_STATES|QUEUE_STATES,limit=1000); statuses=features._status_payload() if active else {}; _monitor_active(features,statuses); _dispatch_ready(features,statuses); features._apply_permission_policies(); _refresh_indexes()
        except Exception as exc: STORE.event(kind="runtime.worker_error",data={"error":f"{type(exc).__name__}: {exc}"[:1000]})
        time.sleep(1.5)


def install(features:Any)->None:
    global INSTALLED
    with INSTALL_LOCK:
        if INSTALLED: return
        STORE.initialize(); recovered=STORE.recover_inflight()
        if recovered: STORE.event(kind="runtime.recovery_scan",data={"tasks":recovered})
        features.enqueue_prompt=lambda payload: enqueue_prompt(features,payload); features.queue_snapshot=queue_snapshot; features.delete_queue_item=delete_queue_item; features.reorder_queue=reorder_queue; features._worker=lambda:worker(features); INSTALLED=True


def _read_json(handler:Any,limit:int=2_000_000)->dict[str,Any]:
    if hasattr(handler,"_feature_body"): return handler._feature_body(limit)
    length=int(handler.headers.get("Content-Length","0"))
    if length<0 or length>limit: raise ValueError("request too large")
    value=json.loads(handler.rfile.read(length).decode("utf-8")) if length else {}
    if not isinstance(value,dict): raise ValueError("JSON object required")
    return value


def _error(handler:Any,exc:Exception)->None: handler.json_response({"ok":False,"error":f"{type(exc).__name__}: {exc}"},status=404 if isinstance(exc,KeyError) else 400 if isinstance(exc,(ValueError,PermissionError)) else 500)


def _create_worktree(project_dir:str,task_id:str)->str:
    root=Path(project_dir).resolve(strict=True); probe=subprocess.run(["git","-C",str(root),"rev-parse","--show-toplevel"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=8.0,check=False)
    if probe.returncode!=0: raise ValueError("worktree isolation requires a Git repository")
    canonical=Path(probe.stdout.strip()).resolve(strict=True); target=STORE.paths.worktrees/task_id
    if target.exists(): raise ValueError("worktree already exists")
    result=subprocess.run(["git","-C",str(canonical),"worktree","add","--detach",str(target),"HEAD"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30.0,check=False)
    if result.returncode!=0: raise RuntimeError(result.stderr.strip() or "git worktree add failed")
    return str(target.resolve())


def _remove_worktree(task:dict[str,Any])->dict[str,Any]:
    metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; worktree=str(metadata.get("worktree") or ""); root=str(metadata.get("ownershipRoot") or "")
    if not worktree or not root: raise ValueError("task has no managed worktree")
    status=subprocess.run(["git","-C",worktree,"status","--porcelain"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=8.0,check=False)
    if status.returncode!=0: raise RuntimeError(status.stderr.strip() or "worktree status failed")
    if status.stdout.strip(): raise ValueError("worktree has uncommitted changes; refusing cleanup")
    result=subprocess.run(["git","-C",root,"worktree","remove",worktree],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=20.0,check=False)
    if result.returncode!=0: raise RuntimeError(result.stderr.strip() or "git worktree remove failed")
    STORE.update_task(task["id"],metadata_patch={"worktree":None}); STORE.event(kind="worktree.removed",task_id=task["id"],session_id=task["session_id"],project_dir=root,data={"path":worktree}); return {"ok":True,"path":worktree}


def _cleanup_new_worktree(root:str,worktree:str)->None:
    """Remove only the worktree just created by this request, never a caller path."""
    target=Path(worktree).resolve(strict=True); managed=STORE.paths.worktrees.resolve(strict=False)
    try: target.relative_to(managed)
    except ValueError as exc: raise RuntimeError("refusing to clean unmanaged worktree") from exc
    result=subprocess.run(["git","-C",root,"worktree","remove",str(target)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=20.0,check=False)
    if result.returncode!=0: raise RuntimeError(result.stderr.strip() or "failed to clean newly-created worktree")


def create_task_request(features:Any,payload:dict[str,Any])->dict[str,Any]:
    base=str(payload.get("sessionID") or ""); directory=features._session_directory(base) if base else features._canonical_directory(str(payload.get("directory") or "")); text=str(payload.get("text") or "").strip()
    if not text: raise ValueError("task text is required")
    profile=_profile_id(payload.get("profile") or "build"); task_id=f"t_{uuid4().hex}"; isolate=bool(payload.get("isolate")); task_dir=directory; sid=base; metadata={"ownershipRoot":directory,"modeAtCreate":str(payload.get("mode") or "build"),"sandbox":REGISTRY.profiles().get(profile,{}).get("sandbox","repo-write")}
    created_session=False
    if isolate:
        task_dir=_create_worktree(directory,task_id); metadata["worktree"]=task_dir; body={"location":{"directory":task_dir},"title":str(payload.get("title") or "Isolated server task")[:200],"agent":"plan-direct" if metadata["modeAtCreate"]=="plan" else "build-direct"}
        if base:
            try:
                source=features._session_info(base)
                if isinstance(source.get("model"),dict): body["model"]=source["model"]
            except Exception: pass
        try:
            created=features._data(features._backend_request_json("POST","/api/session",body,timeout=20.0))
            if not isinstance(created,dict) or not created.get("id"): raise RuntimeError("OpenCode session creation failed for worktree task")
        except Exception:
            _cleanup_new_worktree(directory,task_dir)
            raise
        sid=str(created["id"]); created_session=True
    try:
        if not sid: raise ValueError("sessionID is required unless isolate creates a session")
        metadata["usageBaseline"]=_usage_totals(features,sid); task=STORE.create_task(session_id=sid,project_dir=task_dir,text=text,files=payload.get("files") if isinstance(payload.get("files"),list) else [],profile=profile,priority=int(payload.get("priority") or 0),dependencies=[str(item) for item in (payload.get("dependencies") or []) if item],kind=str(payload.get("kind") or "prompt")[:80],metadata=metadata,baseline=git_snapshot(task_dir),task_id=task_id); STORE.checkpoint(task_id,"created",summary="Standalone server task created"+(" in isolated Git worktree" if isolate else ""),data={"worktree":metadata.get("worktree"),"ownershipRoot":directory}); return {"ok":True,"task":_public(task)}
    except Exception:
        if created_session:
            try: features._backend_request_json("DELETE",f"/api/session/{quote(sid,safe='')}",None,timeout=12.0)
            except Exception: pass
        if isolate:
            try: _cleanup_new_worktree(directory,task_dir)
            except Exception: pass
        raise


def task_control(features:Any,payload:dict[str,Any])->dict[str,Any]:
    task_id=str(payload.get("taskID") or payload.get("id") or ""); task=STORE.get_task(task_id)
    if not task: raise KeyError(task_id)
    action=str(payload.get("action") or "").lower()
    if action=="pause":
        if task["state"] in {"completed","failed","cancelled"}: raise ValueError("terminal task cannot be paused")
        if task["state"] in {"running","submitted","waiting_permission"}: _interrupt(features,task["session_id"])
        task=STORE.transition(task_id,"paused",event="task.paused",data={"source":"user"}); STORE.checkpoint(task_id,"paused",summary="Task paused; resume continues from durable checkpoint",data={"repo":git_snapshot(task["project_dir"])})
    elif action=="resume":
        if task["state"] not in {"paused","recovering","needs_attention"}: raise ValueError("task is not resumable")
        task=STORE.transition(task_id,"queued",event="task.resumed",data={"source":"user"})
    elif action=="cancel":
        if task["state"] in {"completed","failed","cancelled"}: raise ValueError("terminal task cannot be cancelled")
        if task["state"] in {"running","submitted","waiting_permission"}:
            try: _interrupt(features,task["session_id"])
            except Exception: pass
        task=STORE.transition(task_id,"cancelled",event="task.cancelled",data={"source":"user"})
    elif action=="priority": task=STORE.update_task(task_id,priority=int(payload.get("priority") or 0))
    elif action=="dependencies": task=STORE.update_task(task_id,dependencies=[str(item) for item in (payload.get("dependencies") or []) if item])
    elif action=="checkpoint": return {"ok":True,"task":_public(task),"checkpoint":STORE.checkpoint(task_id,str(payload.get("stage") or "manual")[:120],summary=str(payload.get("summary") or "")[:4000],data=payload.get("data") if isinstance(payload.get("data"),dict) else {})}
    elif action=="cleanup-worktree": return {"ok":True,"task":_public(task),"cleanup":_remove_worktree(task)}
    elif action=="handoff":
        handoff=payload.get("handoff") if isinstance(payload.get("handoff"),dict) else {}; task=STORE.update_task(task_id,metadata_patch={"handoff":handoff}); STORE.event(kind="handoff.updated",task_id=task_id,session_id=task["session_id"],project_dir=task["project_dir"],data={"keys":sorted(handoff)})
    else: raise ValueError("unknown task action")
    return {"ok":True,"task":_public(task)}


def _fork(features:Any,sid:str)->dict[str,Any]:
    value=features._data(features._backend_request_json("POST",f"/api/session/{quote(sid,safe='')}/fork",{},timeout=20.0))
    if not isinstance(value,dict) or not value.get("id"): raise RuntimeError("session fork failed")
    return value


def spawn_speculative(features:Any,payload:dict[str,Any])->dict[str,Any]:
    sid=str(payload.get("sessionID") or ""); text=str(payload.get("text") or "").strip()
    if not sid or not text: raise ValueError("sessionID and text are required")
    count=max(2,min(3,int(payload.get("count") or 2))); directory=features._session_directory(sid); children=[]
    for index in range(count):
        fork=_fork(features,sid); child_sid=str(fork["id"]); child=STORE.create_task(session_id=child_sid,project_dir=directory,text=f"Independent researcher {index+1}/{count}. Investigate this problem read-only. Return concrete evidence, risks and a recommended approach.\n\n{text}",files=[],profile="fast",priority=20,kind="research",metadata={"modeAtCreate":"plan","usageBaseline":_usage_totals(features,child_sid),"sandbox":"safe","speculativeRootSession":sid},baseline=git_snapshot(directory)); children.append(child)
    parent=STORE.create_task(session_id=sid,project_dir=directory,text="Compare the independent researcher findings in the structured mailbox. Resolve disagreements, then produce one compact implementation plan or continue the requested work.",files=[],profile="research",priority=30,dependencies=[item["id"] for item in children],kind="aggregate",metadata={"modeAtCreate":"plan","usageBaseline":_usage_totals(features,sid),"sandbox":"safe","speculative":True},baseline=git_snapshot(directory))
    for child in children: STORE.update_task(child["id"],metadata_patch={"mailboxTo":parent["id"]})
    return {"ok":True,"parent":_public(STORE.get_task(parent["id"]) or parent),"children":[_public(STORE.get_task(item["id"]) or item) for item in children]}


def mcp_gateway(features:Any,directory:str,namespace:str|None=None)->dict[str,Any]:
    key=hashlib.sha256(directory.encode()).hexdigest(); cached=STORE.cache_get("mcp-health",key)
    if not isinstance(cached,dict):
        try: value=features._data(features._backend_request_json("GET",features._workspace_target("/api/mcp",directory),timeout=10.0))
        except Exception as exc: value={"error":f"{type(exc).__name__}: {exc}"}
        rows=[]
        if isinstance(value,list):
            for item in value:
                if isinstance(item,dict): rows.append({"namespace":str(item.get("name") or item.get("id") or ""),"status":item.get("status") if isinstance(item.get("status"),(str,dict)) else "unknown"})
        elif isinstance(value,dict):
            for name,item in value.items():
                if isinstance(item,dict): rows.append({"namespace":str(name),"status":item.get("status") if isinstance(item.get("status"),(str,dict)) else "unknown"})
        cached={"namespaces":rows,"generatedAt":now_ms(),"lazyCatalog":True,"credentialsExposed":False}; STORE.cache_set("mcp-health",key,cached,ttl_seconds=15)
    result=dict(cached)
    if namespace:
        selected=next((item for item in result.get("namespaces",[]) if item.get("namespace")==namespace),None); detail={"namespace":namespace,"status":selected.get("status") if selected else "missing"}
        if namespace=="kb":
            try:
                probe=features._run_rag_probe("status"); detail["tools"]=sorted(str(item) for item in (probe.get("tools") or [])) if isinstance(probe,dict) else []
            except Exception: detail["tools"]=[]
        result["detail"]=detail
    return result


def _parse_plan_document(text:str,fallback_title:str)->dict[str,Any]:
    checked:list[dict[str,str]]=[]; bullets:list[dict[str,str]]=[]; title=""; in_fence=False
    for line in str(text or "").splitlines():
        if re.match(r"^\s*```",line): in_fence=not in_fence; continue
        if in_fence: continue
        heading=re.match(r"^\s*#\s+(.+?)\s*$",line)
        if not title and heading: title=heading.group(1)
        checklist=re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\[([ xX>~-])\]\s+(.+?)\s*$",line)
        if checklist:
            marker=checklist.group(1).lower(); status="completed" if marker=="x" else "in_progress" if marker in {">","~","-"} else "pending"
            checked.append({"content":checklist.group(2),"status":status}); continue
        bullet=re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$",line)
        if bullet and not re.match(r"^\[[ xX>~-]\]",bullet.group(1)): bullets.append({"content":bullet.group(1),"status":"pending"})
    return {"title":title or fallback_title,"todos":checked or bullets}


def _read_plan_candidate(path:Path,root:Path)->dict[str,Any]|None:
    try:
        resolved=path.resolve(strict=True); resolved.relative_to(root.resolve(strict=False)); details=resolved.stat()
        if not resolved.is_file() or details.st_size>PLAN_MAX_BYTES: return None
        with resolved.open("rb") as handle: raw=handle.read(PLAN_MAX_BYTES+1)
        if len(raw)>PLAN_MAX_BYTES: return None
        parsed=_parse_plan_document(raw.decode("utf-8"),resolved.stem)
        if not parsed["todos"]: return None
        todos=parsed["todos"]; completed=sum(1 for item in todos if item.get("status")=="completed"); in_progress=sum(1 for item in todos if item.get("status")=="in_progress")
        return {**parsed,"todos":todos[:PLAN_MAX_ITEMS],"total":len(todos),"completed":completed,"inProgress":in_progress,"truncated":len(todos)>PLAN_MAX_ITEMS,"filename":resolved.name,"updated":int(details.st_mtime*1000),"source":"native-v2"}
    except (OSError,UnicodeDecodeError,RuntimeError,ValueError): return None


def latest_plan_document()->dict[str,Any]|None:
    root=PLAN_DIRECTORY
    try:
        root_resolved=root.resolve(strict=True)
        if not root_resolved.is_dir(): return None
    except (OSError,RuntimeError): return None
    try: files=[item for item in root_resolved.iterdir() if item.is_file() and item.suffix.lower()==".md"]
    except OSError: return None
    try: files.sort(key=lambda item:item.stat().st_mtime,reverse=True)
    except OSError: return None
    for candidate in files:
        parsed=_read_plan_candidate(candidate,root_resolved)
        if parsed: return parsed
    return None


def session_plan_document(session_id:str)->dict[str,Any]|None:
    """Read only the native plan owned by one session (never a global fallback)."""
    root=PLAN_DIRECTORY
    try:
        root_resolved=root.resolve(strict=True)
        if not root_resolved.is_dir(): return None
    except (OSError,RuntimeError): return None
    # _read_plan_candidate resolves and confines this derived path to root, so a
    # hostile session id cannot escape the plan directory.
    return _read_plan_candidate(root_resolved/f"{session_id}-plan.md",root_resolved)


def runtime_snapshot(features:Any,directory:str|None=None)->dict[str,Any]:
    tasks=STORE.list_tasks(project_dir=directory,limit=500) if directory else STORE.list_tasks(limit=500)
    return {"version":2,"store":str(STORE.paths.db),"taskCounts":_counts(tasks),"tasks":[_public(task) for task in tasks[:100]],"usage":STORE.usage_summary(),"routing":resource_snapshot(),"secretBroker":SECRETS.snapshot(),"services":{"durableQueue":True,"checkpoints":True,"eventReplay":True,"largeOutputArtifacts":True,"repoIndex":True,"semanticDiff":True,"contextCache":True,"toolResultCache":True,"agentMailbox":True,"typedHandoff":True,"verification":True,"failureClassifier":True,"loopDetector":True,"stuckWatchdog":True,"patchOwnership":True,"speculativeParallelism":True,"providerPinnedRoleRouter":True,"capabilityRegistry":True,"mcpGatewayMetadata":True,"worktreeIsolation":True}}


def handle_get(handler:Any,parsed:Any,features:Any)->bool:
    paths={"/client-runtime.json","/client-tasks.json","/client-task.json","/client-task-events.json","/client-model-capabilities.json","/client-resource-status.json","/client-repo-index.json","/client-artifact.json","/client-project-memory.json","/client-decisions.json","/client-mcp-gateway.json","/client-plan.json"}
    if parsed.path not in paths: return False
    if not handler.authenticated(): handler.unauthorized(); return True
    params=parse_qs(parsed.query,keep_blank_values=True)
    if parsed.path=="/client-plan.json":
        try:
            plan=session_plan_document(str(params["sessionID"][0])) if "sessionID" in params else latest_plan_document()
            handler.json_response({"ok":True,"plan":plan})
        except Exception as exc: _error(handler,exc)
        return True
    try:
        sid=(params.get("sessionID") or [None])[0]; directory=features._session_directory(str(sid)) if sid else (params.get("directory") or [None])[0]; directory=features._canonical_directory(str(directory)) if directory else None
        if parsed.path=="/client-runtime.json": handler.json_response(runtime_snapshot(features,directory))
        elif parsed.path=="/client-tasks.json":
            states=[item for item in (params.get("state") or [""])[0].split(",") if item in TASK_STATES]; rows=STORE.list_tasks(session_id=str(sid) if sid else None,project_dir=directory,states=states or None,limit=int((params.get("limit") or [200])[0])); handler.json_response({"ok":True,"tasks":[_public(item) for item in rows],"counts":_counts(rows)})
        elif parsed.path=="/client-task.json":
            task_id=str((params.get("id") or params.get("taskID") or [""])[0]); task=STORE.get_task(task_id)
            if not task: raise KeyError(task_id)
            handler.json_response({"ok":True,"task":_public(task),"checkpoints":STORE.checkpoints(task_id),"events":STORE.events(task_id=task_id),"artifacts":ARTIFACTS.list(task_id),"usage":STORE.usage_summary(task_id),"mailbox":STORE.mailbox_receive(task_id)})
        elif parsed.path=="/client-task-events.json": handler.json_response({"ok":True,"events":STORE.events(task_id=(params.get("taskID") or [None])[0],project_dir=directory,after=int((params.get("after") or [0])[0]),limit=int((params.get("limit") or [500])[0]))})
        elif parsed.path=="/client-model-capabilities.json":
            if not directory: raise ValueError("directory or sessionID is required")
            handler.json_response(capability_snapshot(features,directory))
        elif parsed.path=="/client-resource-status.json": handler.json_response(resource_snapshot())
        elif parsed.path=="/client-repo-index.json":
            if not directory: raise ValueError("directory or sessionID is required")
            query=str((params.get("q") or [""])[0]); handler.json_response(INDEXER.search(directory,query,limit=int((params.get("limit") or [40])[0])) if query else INDEXER.refresh(directory))
        elif parsed.path=="/client-artifact.json":
            aid=str((params.get("id") or [""])[0]); value=ARTIFACTS.get(aid,offset=int((params.get("offset") or [0])[0]),limit=int((params.get("limit") or [64000])[0]),query=(params.get("q") or [None])[0])
            if value is None: raise KeyError(aid)
            handler.json_response(value)
        elif parsed.path=="/client-project-memory.json":
            if not directory: raise ValueError("directory or sessionID is required")
            handler.json_response({"ok":True,"memory":STORE.memory_list(directory)})
        elif parsed.path=="/client-decisions.json":
            if not directory: raise ValueError("directory or sessionID is required")
            handler.json_response({"ok":True,"decisions":STORE.decision_list(directory)})
        elif parsed.path=="/client-mcp-gateway.json":
            if not directory: raise ValueError("directory or sessionID is required")
            handler.json_response(mcp_gateway(features,directory,(params.get("namespace") or [None])[0]))
        return True
    except Exception as exc: _error(handler,exc); return True


def handle_post(handler:Any,parsed:Any,features:Any)->bool:
    paths={"/client-task-control.json","/client-task-create.json","/client-project-memory.json","/client-decisions.json","/client-mailbox.json","/client-speculate.json","/client-artifact.json"}
    if parsed.path not in paths: return False
    if not handler.authenticated(): handler.unauthorized(); return True
    try:
        payload=_read_json(handler)
        if parsed.path=="/client-task-control.json": handler.json_response(task_control(features,payload))
        elif parsed.path=="/client-task-create.json": handler.json_response(create_task_request(features,payload))
        elif parsed.path=="/client-project-memory.json":
            directory=features._session_directory(str(payload["sessionID"])) if payload.get("sessionID") else features._canonical_directory(str(payload.get("directory") or "")); STORE.memory_set(directory,str(payload.get("key") or "note"),str(payload.get("value") or ""),str(payload.get("category") or "note")); handler.json_response({"ok":True,"memory":STORE.memory_list(directory)})
        elif parsed.path=="/client-decisions.json":
            directory=features._session_directory(str(payload["sessionID"])) if payload.get("sessionID") else features._canonical_directory(str(payload.get("directory") or "")); handler.json_response({"ok":True,"decision":STORE.decision_add(directory,str(payload.get("title") or "Decision"),str(payload.get("decision") or ""),str(payload.get("rationale") or ""))})
        elif parsed.path=="/client-mailbox.json":
            task=STORE.get_task(str(payload.get("toTask") or payload.get("fromTask") or "")); directory=str(payload.get("projectDir") or (task or {}).get("project_dir") or "")
            if not directory: raise ValueError("projectDir or task reference required")
            item=STORE.mailbox_send(project_dir=directory,from_task=str(payload.get("fromTask") or "") or None,to_task=str(payload.get("toTask") or "") or None,message_type=str(payload.get("type") or "finding"),payload=payload.get("payload") if isinstance(payload.get("payload"),dict) else {"text":str(payload.get("text") or "")}); handler.json_response({"ok":True,"message":item})
        elif parsed.path=="/client-speculate.json": handler.json_response(spawn_speculative(features,payload))
        elif parsed.path=="/client-artifact.json": handler.json_response({"ok":True,"artifact":ARTIFACTS.put(task_id=str(payload.get("taskID") or "") or None,project_dir=str(payload.get("projectDir") or "") or None,kind=str(payload.get("kind") or "note"),title=str(payload.get("title") or "Artifact"),content=str(payload.get("content") or ""),summary=str(payload.get("summary") or ""),mime=str(payload.get("mime") or "text/plain"))})
        return True
    except Exception as exc: _error(handler,exc); return True

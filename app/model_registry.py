#!/usr/bin/env python3
"""Model capability registry, profiles and resource-aware routing decisions."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import time
from typing import Any
from urllib.parse import urlsplit
import urllib.request


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None: return default
    return value.strip().lower() not in {"0","false","no","off",""}


def _float(value: str | None, default: float) -> float:
    try: return float(value) if value is not None else default
    except ValueError: return default


def model_ref(model: dict[str, Any]) -> str:
    provider=str(model.get("providerID") or model.get("provider") or ""); ident=str(model.get("id") or model.get("modelID") or "")
    return f"{provider}/{ident}" if provider and ident else ident


def _cost_class(model: dict[str, Any], ref: str) -> str:
    costs=model.get("cost"); rows=costs if isinstance(costs,list) else [costs] if isinstance(costs,dict) else []; numeric=[]
    for row in rows:
        if not isinstance(row,dict): continue
        for key in ("input","output"):
            value=row.get(key)
            if isinstance(value,(int,float)): numeric.append(float(value))
    if numeric and all(value==0 for value in numeric): return "free"
    low=ref.lower()
    if any(token in low for token in ("flash","mini","nano","free")): return "cheap"
    if any(token in low for token in ("max","pro","opus")): return "premium"
    return "standard"


def _quality_hints(ref: str) -> dict[str, Any]:
    low=ref.lower(); flash="flash" in low; qwen_max="qwen3.8-max" in low or "qwen3.8-orchestrated" in low; codeish=any(token in low for token in ("qwen","deepseek","codex","gpt"))
    return {"fastPath":flash,"coding":.92 if qwen_max else .82 if codeish else .65,"review":.94 if qwen_max else .78 if codeish else .62,"planning":.95 if qwen_max else .76 if flash else .72}


class CapabilityRegistry:
    def __init__(self,catalog:list[dict[str,Any]]|None=None): self.catalog=[]; self._models={}; self.refresh(catalog or [])
    def refresh(self,catalog:list[dict[str,Any]]) -> None:
        self.catalog=[item for item in catalog if isinstance(item,dict)]; models={}
        for item in self.catalog:
            ref=model_ref(item)
            if not ref: continue
            caps=item.get("capabilities") if isinstance(item.get("capabilities"),dict) else {}
            inputs=caps.get("input") if isinstance(caps.get("input"),list) else item.get("input") if isinstance(item.get("input"),list) else []
            limit=item.get("limit") if isinstance(item.get("limit"),dict) else {}; context=limit.get("context") or item.get("contextWindow") or item.get("context") or 0
            try: context=int(context or 0)
            except (TypeError,ValueError): context=0
            models[ref]={"ref":ref,"providerID":str(item.get("providerID") or item.get("provider") or ""),"id":str(item.get("id") or item.get("modelID") or ""),"name":str(item.get("name") or item.get("id") or ref),"vision":"image" in inputs,"tools":caps.get("tools") is True or item.get("tool_call") is True,"input":inputs,"context":context,"contextClass":"huge" if context>=500_000 else "large" if context>=180_000 else "medium" if context>=64_000 else "small","costClass":_cost_class(item,ref),**_quality_hints(ref)}
        local=os.environ.get("OPENCODE_LOCAL_CODER_MODEL","ollama/qwen3.8:27b").strip()
        if local and local not in models:
            provider,_,ident=local.partition("/"); models[local]={"ref":local,"providerID":provider,"id":ident,"name":ident or local,"vision":False,"tools":True,"input":["text"],"context":24576,"contextClass":"small","costClass":"local","fastPath":False,"coding":.80,"review":.68,"planning":.68,"available":None}
        self._models=models
    def models(self)->list[dict[str,Any]]: return sorted(self._models.values(),key=lambda item:(item["providerID"],item["name"].casefold()))
    def get(self,ref:str)->dict[str,Any]|None: return self._models.get(ref)
    def profiles(self)->dict[str,dict[str,Any]]:
        local=os.environ.get("OPENCODE_LOCAL_CODER_MODEL","ollama/qwen3.8:27b").strip(); cloud=os.environ.get("OPENCODE_CLOUD_CODER_MODEL","bailian-cli/qwen3.8-max").strip(); orchestrated=os.environ.get("OPENCODE_ORCHESTRATED_MODEL","bailian-cli/qwen3.8-orchestrated").strip(); fast=os.environ.get("OPENCODE_FAST_MODEL","bailian-cli/qwen3.6-flash").strip(); review=os.environ.get("OPENCODE_REVIEW_MODEL","bailian-cli/qwen3.8-max").strip()
        return {
            "direct":{"id":"direct","label":"Selected model","route":"selected","agentBuild":"build","agentPlan":"plan","orchestrated":False,"contextBudget":96000,"sandbox":"repo-write","autoReview":False},
            "qwen3.8-coder":{"id":"qwen3.8-coder","label":"Qwen 3.8 Coder · Auto","route":"auto","cloudModel":cloud,"localModel":local,"agentBuild":"build","agentPlan":"plan","orchestrated":False,"contextBudget":160000,"sandbox":"repo-write","autoReview":"smart","requires":{"tools":True,"coding":.75}},
            "qwen3.8-orchestrated":{"id":"qwen3.8-orchestrated","label":"Qwen 3.8 · Orchestrated","route":"cloud","cloudModel":orchestrated,"workerModel":fast,"agentBuild":"build","agentPlan":"plan","orchestrated":True,"contextBudget":260000,"sandbox":"repo-write","autoReview":"smart","requires":{"tools":True,"coding":.80,"planning":.85}},
            "qwen3.8-review":{"id":"qwen3.8-review","label":"Qwen 3.8 · Review","route":"cloud","cloudModel":review,"agentBuild":"build","agentPlan":"plan","orchestrated":False,"contextBudget":128000,"sandbox":"safe","autoReview":False,"requires":{"tools":True,"review":.85}},
            "qwen3.8-fast":{"id":"qwen3.8-fast","label":"Qwen · Fast path","route":"cloud","cloudModel":fast,"agentBuild":"build","agentPlan":"plan","orchestrated":False,"contextBudget":72000,"sandbox":"safe","autoReview":False,"requires":{"tools":True,"fastPath":True}},
        }
    def snapshot(self,stats_getter=None)->dict[str,Any]:
        rows=[]
        for item in self.models():
            row=dict(item)
            if stats_getter:
                try: row["telemetry"]=stats_getter(item["ref"])
                except Exception: row["telemetry"]={"samples":0}
            rows.append(row)
        return {"version":1,"models":rows,"profiles":list(self.profiles().values())}


@dataclass
class ResourceDecision:
    mode:str; profile:str; selected_model:str|None; reason:str; game_detected:bool; pressure_high:bool; local_available:bool|None; processes:list[str]; load_ratio:float|None
    def as_dict(self)->dict[str,Any]: return {"mode":self.mode,"profile":self.profile,"selectedModel":self.selected_model,"reason":self.reason,"gameDetected":self.game_detected,"pressureHigh":self.pressure_high,"localAvailable":self.local_available,"matchedProcesses":self.processes,"loadRatio":self.load_ratio}


class ResourceScheduler:
    def __init__(self): self._local_health_at=0.; self._local_health=None
    def _processes(self)->set[str]:
        override=os.environ.get("OPENCODE_PROCESS_SNAPSHOT")
        if override is not None: return {item.strip().casefold() for item in override.split(";") if item.strip()}
        names=set(); proc=Path("/proc")
        if not proc.is_dir(): return names
        for child in list(proc.iterdir())[:10000]:
            if not child.name.isdigit(): continue
            try:
                name=(child/"comm").read_text(encoding="utf-8",errors="ignore").strip().casefold()
                if name: names.add(name)
            except OSError: continue
        return names
    def pressure(self)->tuple[bool,float|None]:
        forced=os.environ.get("OPENCODE_RESOURCE_PRESSURE")
        if forced:
            high=forced.strip().lower() in {"1","high","true","yes"}; return high,1.0 if high else 0.0
        try:
            ratio=os.getloadavg()[0]/(os.cpu_count() or 1); return ratio>=_float(os.environ.get("OPENCODE_RESOURCE_CPU_THRESHOLD"),.85),round(ratio,3)
        except (AttributeError,OSError): return False,None
    def game_state(self)->tuple[bool,list[str]]:
        configured=[item.strip().casefold() for item in os.environ.get("OPENCODE_GAME_PROCESSES","").split(";") if item.strip()]
        if not configured: return False,[]
        running=self._processes(); matched=sorted({wanted for wanted in configured if any(wanted==proc or wanted in proc for proc in running)}); return bool(matched),matched
    def local_available(self,force:bool=False)->bool|None:
        now=time.monotonic()
        if not force and now-self._local_health_at<8.: return self._local_health
        base=os.environ.get("OLLAMA_BASE_URL","http://localhost:11434/v1").strip()
        try:
            parts=urlsplit(base)
            if parts.hostname not in {"localhost","127.0.0.1","::1"} and not _bool(os.environ.get("OPENCODE_ALLOW_REMOTE_LOCAL_PROVIDER"),False): self._local_health=False
            else:
                with urllib.request.urlopen(base.rstrip("/")+"/models",timeout=.45) as response: self._local_health=200<=response.status<500
        except Exception: self._local_health=False
        self._local_health_at=now; return self._local_health
    def decide(self,profile:dict[str,Any],*,selected_model:str|None=None)->ResourceDecision:
        mode=os.environ.get("OPENCODE_RESOURCE_SCHEDULER","auto").strip().lower(); route=str(profile.get("route") or "selected"); game,matched=self.game_state(); pressure,ratio=self.pressure(); local_ok=None
        if mode in {"off","observe"} or route=="selected": return ResourceDecision(mode,str(profile.get("id") or "direct"),selected_model,"selected model is preserved",game,pressure,None,matched,ratio)
        cloud=str(profile.get("cloudModel") or selected_model or "") or None; local=str(profile.get("localModel") or "") or None
        if route=="cloud": return ResourceDecision(mode,str(profile.get("id")),cloud,"profile is cloud-pinned",game,pressure,None,matched,ratio)
        if route=="local":
            local_ok=self.local_available(); return ResourceDecision(mode,str(profile.get("id")),local if local_ok else cloud,"local profile" if local_ok else "local unavailable; cloud fallback",game,pressure,local_ok,matched,ratio)
        if game: return ResourceDecision(mode,str(profile.get("id")),cloud,"game process detected; route to cloud",True,pressure,None,matched,ratio)
        if pressure: return ResourceDecision(mode,str(profile.get("id")),cloud,"host pressure high; route to cloud",False,True,None,matched,ratio)
        if local:
            local_ok=self.local_available()
            if local_ok: return ResourceDecision(mode,str(profile.get("id")),local,"host idle and local model reachable",False,False,True,matched,ratio)
        return ResourceDecision(mode,str(profile.get("id")),cloud,"local unavailable or not configured; cloud fallback",False,False,local_ok,matched,ratio)
    def snapshot(self,profiles:dict[str,dict[str,Any]])->dict[str,Any]:
        game,matched=self.game_state(); pressure,ratio=self.pressure(); local=self.local_available()
        return {"mode":os.environ.get("OPENCODE_RESOURCE_SCHEDULER","auto"),"gameDetected":game,"matchedProcesses":matched,"pressureHigh":pressure,"loadRatio":ratio,"localAvailable":local,"decisions":{key:self.decide(value).as_dict() for key,value in profiles.items() if value.get("route") in {"auto","cloud","local"}}}

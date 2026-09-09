#!/usr/bin/env python3
from __future__ import annotations

import base64
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any

from install_health import web_auth_headers

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"app"))


def retry(fn,timeout=20.0):
    deadline=time.monotonic()+timeout; last=(False,"not checked")
    while True:
        try: last=fn()
        except Exception as exc: last=(False,f"{type(exc).__name__}: {exc}")
        if last[0] or time.monotonic()>=deadline: return last
        time.sleep(.5)


def main()->int:
    checks:list[dict[str,Any]]=[]
    def add(name,ok,detail): checks.append({"name":name,"ok":bool(ok),"detail":str(detail)})
    config_dir=Path(os.environ.get("OPENCODE_CONFIG_DIR") or (Path.home()/".config/opencode")).expanduser()
    config_path=config_dir/"opencode.json"
    try:
        config=json.loads(config_path.read_text(encoding="utf-8")); kb=(((config.get("mcp") or {}).get("servers") or {}).get("kb") or {})
        good=(config.get("compaction") or {}).get("auto") is True and ((config.get("compaction") or {}).get("keep") or {}).get("tokens")==12000 and (config.get("compaction") or {}).get("buffer")==24000 and (config.get("tool_output") or {}).get("max_bytes")==48000 and kb.get("codemode") is True
        add("runtime-v3-config",good,"native compaction + bounded tool output + MCP Code Mode")
    except Exception as exc: add("runtime-v3-config",False,f"{type(exc).__name__}: {exc}")
    plugin=config_dir/"plugins/server-runtime-guard.js"; add("runtime-v3-plugin-file",plugin.is_file(),str(plugin))
    visible_plan=config_dir/"plugins/visible-plan.js"; add("visible-plan-plugin-file",visible_plan.is_file(),str(visible_plan))

    try:
        import server_workflow
        base=server_workflow.rag.plus.ext.base
        host=str(base.WEB_HOST).strip("[]")
        if host in {"0.0.0.0","::"}: host="localhost"
        def web():
            conn=http.client.HTTPConnection(host,int(base.WEB_PORT),timeout=4)
            try:
                conn.request("GET","/client-runtime-v3.json",headers=web_auth_headers(base)); response=conn.getresponse(); body=response.read(2_000_000)
                if response.status!=200: return False,f"HTTP {response.status}: {body[:200]!r}"
                value=json.loads(body); services=value.get("services") or {}; required={"nativeDynamicCompaction","astIndex","repoEmbeddings","mcpCodeMode","sandboxEnforcement","sharedNativeRAG","zeroTokenReplay"}; missing=sorted(k for k in required if services.get(k) is not True)
                return not missing,"runtime v3 services active" if not missing else "missing: "+", ".join(missing)
            finally: conn.close()
        ok,detail=retry(web); add("runtime-v3-web",ok,detail)
    except BaseException as exc: add("runtime-v3-web",False,f"{type(exc).__name__}: {exc}")

    opencode2=shutil.which("opencode2")
    if opencode2:
        try:
            env=os.environ.copy(); env.pop("OPENCODE_CONFIG_DIR",None)
            proc=subprocess.run([opencode2,"service","get","env"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10,check=False,env=env); service_env=json.loads(proc.stdout) if proc.returncode==0 else {}
            required=["OPENCODE_WEB_PORT"]
            token_ok=bool(service_env.get("OPENCODE_RUNTIME_PLUGIN_TOKEN") or service_env.get("OPENCODE_SERVER_PASSWORD")); missing=[name for name in required if not service_env.get(name)]
            add("runtime-v3-service-env",not missing and token_ok,"plugin local control-plane credentials persisted" if not missing and token_ok else f"missing={missing}, token={token_ok}")
        except Exception as exc: add("runtime-v3-service-env",False,f"{type(exc).__name__}: {exc}")
        try:
            import server_workflow
            target=server_workflow.rag._v2_workspace_target("/api/plugin",str(server_workflow.rag.plus.ext.base.SCRATCH_ROOT))
            plugins=server_workflow.features._data(server_workflow.features._backend_request_json("GET",target,timeout=8.0))
            rows=[item for item in (plugins or []) if isinstance(item,dict)]; guard=next((item for item in rows if item.get("id")=="custom-opencode.server-runtime-guard" or str((item.get("source") or {}).get("path","")).endswith("server-runtime-guard.js")),None); visible=next((item for item in rows if item.get("id")=="custom.visible-plan" or str((item.get("source") or {}).get("path","")).endswith("visible-plan.js")),None)
            state=guard.get("state") if guard else None
            status=state.get("status") if isinstance(state,dict) and state.get("status") is not None else (guard.get("status") if guard else None)
            add("runtime-v3-plugin-active",bool(guard and status=="active"),status if guard else "not found")
            visible_state=visible.get("state") if visible else None
            visible_status=visible_state.get("status") if isinstance(visible_state,dict) and visible_state.get("status") is not None else (visible.get("status") if visible else None)
            add("visible-plan-plugin-active",bool(visible and visible_status=="active"),visible_status if visible else "not found")
        except Exception as exc:
            add("runtime-v3-plugin-active",False,f"{type(exc).__name__}: {exc}")
            add("visible-plan-plugin-active",False,f"{type(exc).__name__}: {exc}")
    else:
        add("runtime-v3-service-env",False,"opencode2 not found")
        add("runtime-v3-plugin-active",False,"opencode2 not found")
        add("visible-plan-plugin-active",False,"opencode2 not found")

    failed=[item for item in checks if not item["ok"]]
    print("==> Runtime V3 post-install self-test")
    for item in checks: print(f"[{'PASS' if item['ok'] else 'FAIL'}] {item['name']}: {item['detail']}")
    print("Runtime V3 self-test PASS" if not failed else "Runtime V3 self-test FAILED")
    return 0 if not failed else 1


if __name__=="__main__": raise SystemExit(main())

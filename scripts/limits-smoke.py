#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("OPENCODE_SERVER_PASSWORD", "test")
os.environ.setdefault("OPENCODE_BACKEND_URL", "http://localhost:9")
os.environ.setdefault("OPENCODE_BACKEND_PASSWORD", "test")
os.environ.setdefault("OPENCODE_SCRATCH_DIRECTORY", str(Path(tempfile.gettempdir()) / "custom-opencode-limits-smoke-scratch"))
sys.path.insert(0, str(ROOT / "app"))

with tempfile.TemporaryDirectory() as temp:
    fake = Path(temp) / "codex"
    fake.write_text(
        "#!/usr/bin/env python3\n"
        "import json,sys\n"
        "for line in sys.stdin:\n"
        " r=json.loads(line)\n"
        " if r.get('method')=='initialize': print(json.dumps({'id':r['id'],'result':{'ok':True}}),flush=True)\n"
        " elif r.get('method')=='account/rateLimits/read': print(json.dumps({'id':r['id'],'result':{'rateLimits':{},'rateLimitsByLimitId':{'codex':{'planType':'plus','primary':{'usedPercent':37,'windowDurationMins':300,'resetsAt':2000000000},'secondary':{'usedPercent':72,'windowDurationMins':10080,'resetsAt':2000100000}}}}}),flush=True)\n",
        encoding="utf-8",
    )
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    os.environ["CODEX_BIN"] = str(fake)

    import server_ext

    server_ext.base.backend_json = lambda method, target: {
        "data": [{"title": "Smoke · Qwen exhausted→08-29 02:00 UTC"}]
    }
    server_ext._codex_cache.update(at=0.0, value=None)

    codex = server_ext.query_codex_rate_limits()
    assert codex["available"] is True
    assert codex["primary"]["remainingPercent"] == 63
    assert codex["primary"]["windowDurationMins"] == 300
    assert codex["secondary"]["remainingPercent"] == 28
    assert codex["secondary"]["windowDurationMins"] == 10080

    qwen = server_ext.query_qwen_status()
    assert qwen["state"] == "exhausted"
    assert qwen["fiveHour"]["limit"] == 12_000
    assert qwen["sevenDay"]["limit"] == 40_000

print("Limits smoke passed: Codex app-server RPC + Qwen caps/probe")

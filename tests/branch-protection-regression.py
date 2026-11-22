#!/usr/bin/env python3
"""Offline CLI fixtures only: never sends a repository administration request."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FAKE = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
args=sys.argv[1:]
root=pathlib.Path(os.environ['FIXTURE_ROOT']); mode=os.environ['FIXTURE_MODE']
sha='a'*40
if '--method' in args:
    (root/'write.json').write_text(sys.stdin.read())
    print('{}')
elif any('/check-runs' in x for x in args):
    checks=[{'id':i+1,'name':name,'status':'completed','conclusion':'success','head_sha':sha}
        for i,name in enumerate(['model-free-matrix','native-clean-install','native-budget-wire','kernel-sandbox'])]
    if mode in ('failed','pending','different-sha'):
        newer=dict(checks[0],id=100)
        if mode=='failed': newer['conclusion']='failure'
        if mode=='pending': newer.update(status='in_progress',conclusion=None)
        if mode=='different-sha': newer['head_sha']='b'*40
        checks.append(newer)
    print(json.dumps([{'check_runs':checks[:2]},{'check_runs':checks[2:]}]))
elif any(x.endswith('/protection') for x in args): print('{}')
else:
    count=root/'read-count'; n=int(count.read_text()) if count.exists() else 0
    count.write_text(str(n+1))
    print('b'*40 if mode=='moved' and n else sha)
"""
for mode in ("success", "failed", "pending", "different-sha", "moved"):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        fake = root / "gh"
        fake.write_text(FAKE)
        fake.chmod(0o700)
        env = dict(
            os.environ,
            PATH=f"{root}:{os.environ['PATH']}",
            FIXTURE_ROOT=temporary,
            FIXTURE_MODE=mode,
        )
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/protect-main.sh")],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        wrote = (root / "write.json").exists()
        assert (result.returncode == 0) == (mode == "success"), (mode, result.stderr)
        assert wrote == (mode == "success"), mode
        if wrote:
            policy = json.loads((root / "write.json").read_text())
            assert policy["enforce_admins"] is True
            assert len(policy["required_status_checks"]["contexts"]) == 4
            assert not policy["allow_force_pushes"] and not policy["allow_deletions"]
print("PASS: 5 offline branch-protection fixtures; no GitHub administration request sent")

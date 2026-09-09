#!/usr/bin/env python3
"""Real native service + disposable crashing stdio MCP, without model inference."""
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def fixture(counter):
    path = Path(counter)
    launches = int(path.read_text()) + 1 if path.exists() else 1
    path.write_text(str(launches))
    armed = False
    for line in sys.stdin:
        message = json.loads(line)
        if 'id' not in message:
            continue
        method = message['method']
        if method == 'initialize':
            result = {'protocolVersion':message['params']['protocolVersion'], 'capabilities':{'tools':{}}, 'serverInfo':{'name':'recovery-fixture','version':'1'}}
        elif method == 'tools/list':
            result = {'tools':[{'name':'fixture_ping','description':'Read-only fixture ping','inputSchema':{'type':'object','properties':{}}}]}
            if launches == 1 and not armed:
                armed = True
                threading.Timer(3, lambda: os._exit(9)).start()
        elif method == 'tools/call':
            result = {'content':[{'type':'text','text':'pong'}]}
        else:
            result = {}
        print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}), flush=True)


def main():
    binary = shutil.which('opencode2')
    assert binary, 'opencode2 required'
    with tempfile.TemporaryDirectory(prefix='opencode-mcp-recovery-') as temporary:
        root = Path(temporary)
        env = {k:v for k,v in os.environ.items() if not k.startswith(('OPENCODE_', 'CUSTOM_OPENCODE_', 'XDG_'))}
        env.update({f'XDG_{key}_HOME':str(root/value) for key,value in [('CONFIG','config'),('DATA','data'),('STATE','state'),('CACHE','cache')]})
        config = root/'config/opencode'
        (config/'plugins').mkdir(parents=True)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        (config/'service.json').write_text(json.dumps({'hostname':'127.0.0.1','port':port,'password':'recovery-fixture'}))
        project = root/'project'
        project.mkdir()
        counter = root/'launches'
        shutil.copy2(ROOT/'config/plugins/mcp-reconnect.js', config/'plugins/mcp-reconnect.js')
        (config/'opencode.json').write_text(json.dumps({'update':'disable','mcp':{'servers':{
            'flaky':{'type':'local','command':[sys.executable,str(Path(__file__).resolve()),'--mcp',str(counter)],'timeout':{'startup':5000,'catalog':5000,'execution':5000}},
            'disabled':{'type':'local','command':[sys.executable,'-c','raise SystemExit(1)'],'disabled':True},
        }}}))
        try:
            subprocess.run([binary,'service','start'],env=env,cwd=project,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=45)
            service = json.loads((root/'state/opencode/service.json').read_text())
            def request(method, path):
                token = base64.b64encode(('opencode:'+service['password']).encode()).decode()
                with urlopen(Request(service['url']+path,method=method,headers={'Authorization':'Basic '+token}),timeout=15) as response:
                    body = response.read()
                    return json.loads(body)['data'] if body else None
            query = '?'+urlencode({'location[directory]':str(project)})
            seen = []
            deadline = time.monotonic()+45
            while time.monotonic() < deadline:
                rows = {row['name']:row['status']['status'] for row in request('GET','/api/mcp'+query)}
                if 'disabled' not in rows or 'flaky' not in rows:
                    time.sleep(.3)
                    continue
                assert rows['disabled'] == 'disabled'
                if not seen or seen[-1] != rows['flaky']:
                    seen.append(rows['flaky'])
                    print('native MCP:',rows['flaky'],flush=True)
                if counter.exists() and int(counter.read_text()) >= 2 and rows['flaky'] == 'connected':
                    break
                time.sleep(.3)
            assert seen.count('connected') >= 2 and 'failed' in seen, seen
            assert int(counter.read_text()) == 2
            request('POST','/api/mcp/flaky/disconnect'+query)
            time.sleep(5)
            rows = {row['name']:row['status']['status'] for row in request('GET','/api/mcp'+query)}
            assert rows['flaky'] == 'disabled' and int(counter.read_text()) == 2, rows
            print('Live MCP recovery passed: real process crash → automatic reconnect; manual disconnect respected')
        except Exception:
            log = root/'data/opencode/log/opencode.log'
            if log.exists():
                for line in log.read_text().splitlines():
                    if 'recovery' in line or 'level=ERROR' in line or 'level=WARN' in line:
                        print(line[:1200],file=sys.stderr)
            raise
        finally:
            subprocess.run([binary,'service','stop'],env=env,cwd=project,capture_output=True,timeout=20)


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--mcp':
        fixture(sys.argv[2])
    else:
        main()

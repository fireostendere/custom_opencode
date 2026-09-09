#!/usr/bin/env python3
"""Open installed TUI wizards and panel views in a real PTY, without inference.

Requires a dedicated HOME containing .custom-opencode-audit-home and an installed
custom-opencode wrapper. This is an opening/cancellation smoke, not exhaustive
keyboard, clipboard or desktop terminal-emulator coverage.
"""
from __future__ import annotations
import argparse
import base64
import fcntl
import http.client
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import termios
import time
from urllib.parse import urlparse


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    home = args.home.resolve()
    if not (home/'.custom-opencode-audit-home').is_file():
        parser.error('Not an explicitly marked audit HOME')
    service = json.loads((home/'.local/state/opencode/service.json').read_text())
    url = urlparse(service['url'])
    if url.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        parser.error('Audit requires loopback backend')
    headers = {'Authorization': 'Basic '+base64.b64encode(('opencode:'+service['password']).encode()).decode(), 'Content-Type': 'application/json'}
    def request(method, path, body=None):
        connection = http.client.HTTPConnection(url.hostname, url.port, timeout=15)
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            if not 200 <= response.status < 300:
                raise RuntimeError(f'Native API {method} {path}: HTTP {response.status}')
            return json.loads(raw)['data'] if raw else None
        finally:
            connection.close()
    session = request('POST', '/api/session', {'title': 'Terminal acceptance', 'model': {'providerID': 'bailian-cli', 'id': 'qwen3.8-max'}, 'location': {'directory': str(home/'scratch')}})
    sid = session['id']
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
    env = {k: v for k, v in os.environ.items() if not k.startswith(('OPENCODE_', 'CUSTOM_OPENCODE_', 'TOKEN_PLAN_', 'GEMINI_', 'GOOGLE_'))}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home/'.config'), XDG_DATA_HOME=str(home/'.local/share'), XDG_STATE_HOME=str(home/'.local/state'), XDG_CACHE_HOME=str(home/'.cache'), TERM='xterm-256color')
    process = subprocess.Popen([str(home/'.local/bin/custom-opencode'), '--session', sid], cwd=home/'scratch', env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    ansi = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]')
    trace = bytearray()
    rows = []
    def read(seconds):
        output = bytearray()
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            if select.select([master], [], [], .1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: break
        trace.extend(output)
        return ansi.sub('', output.decode('utf8', 'replace'))
    cases = [
        ('/addprovider', 'Provider ID'), ('/addmodel', 'Provider ID'),
        ('/addmcp', 'MCP name'), ('/addskill', 'Skill ID'),
        ('/addorchestration', 'Provider ID'), ('/addmcpprofile', 'Profile ID'),
        ('/configure', 'Configuration'), ('/server', 'web server'),
        ('/webserver', 'Web'), ('/models', 'Select Model'),
        ('/panel right session', 'Сессия'), ('/panel right activity', 'RIGHT Activity'),
        ('/panel right plan', 'Плана пока нет.'), ('/panel right orchestration', 'Оркестрация пока пустая.'),
        ('/panel right history', 'История'), ('/panel right limits', 'Лимиты'),
    ]
    try:
        initial = read(5)
        rows.append({'command': 'startup', 'ok': 'Build' in initial and 'Alibaba Cloud' in initial})
        for command, expected in cases:
            os.write(master, command.encode())
            text = read(.2)
            os.write(master, b'\r')
            text += read(2)
            if command == '/models' and expected not in text:
                # The first Enter accepts native slash completion; the next runs it.
                os.write(master, b'\r')
                text += read(2)
            rows.append({'command': command, 'expected': expected, 'ok': expected.lower() in text.lower()})
            if command == '/models' and expected in text:
                os.write(master, b'Qwen3.7 Plus')
                read(.3)
                os.write(master, b'\r')
                read(1)
                selected = request('GET', f'/api/session/{sid}')['model']
                rows.append({'command': 'select Qwen3.7 Plus', 'ok': selected['providerID'] == 'bailian-cli' and selected['id'] == 'qwen3.7-plus'})
            os.write(master, b'\x1b')
            read(.4)
            os.write(master, b'\x15')
            read(.1)
        final = request('GET', f'/api/session/{sid}')
        tokens = final['tokens']
        rows.append({'command': 'zero inference', 'ok': final['cost'] == 0 and all(tokens[k] == 0 for k in ['input', 'output', 'reasoning']) and all(v == 0 for v in tokens['cache'].values())})
    finally:
        process.terminate()
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        os.close(master)
        request('DELETE', f'/api/session/{sid}')
    text = ansi.sub('', trace.decode('utf8', 'replace'))
    errors = re.findall(r'Cannot find (?:package|module)|No renderer found|Plugin failed|Configuration response missing', text)
    report = {'ok': all(row['ok'] for row in rows) and not errors, 'geometry': '160x40', 'checks': rows, 'errors': errors}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    args.output.with_suffix('.typescript').write_bytes(trace)
    for row in rows: print(('PASS' if row['ok'] else 'FAIL')+' native PTY '+row['command'], flush=True)
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Single Escape -> native terminal -> provider disconnect; no paid inference."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
started, disconnected = threading.Event(), threading.Event()


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        started.set()
        try:
            for _ in range(400):
                chunk = {'id': 'chatcmpl-stop', 'object': 'chat.completion.chunk',
                         'created': 1, 'model': 'fixture', 'choices': [{'index': 0,
                         'delta': {'content': 'working '}, 'finish_reason': None}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                self.wfile.flush()
                time.sleep(.05)
        except (BrokenPipeError, ConnectionResetError):
            disconnected.set()


def main():
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    binary = shutil.which('opencode2')
    with tempfile.TemporaryDirectory(prefix='astra-interrupt-') as temporary:
        home = Path(temporary)
        config = home / '.config/opencode'
        project = home / 'project'
        project.mkdir()
        shutil.copytree(ROOT / 'config/plugins/tui', config / 'plugins/tui')
        (config / 'node_modules').symlink_to(Path.home() / '.config/opencode/node_modules')
        (config / 'cli.json').write_text(json.dumps({'keybinds': {'app.exit': 'ctrl+shift+q'}}))
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        (config / 'service.json').write_text(json.dumps({'hostname': '127.0.0.1', 'port': port, 'password': 'local-fixture'}))
        (config / 'opencode.json').write_text(json.dumps({
            'update': 'disable', 'providers': {'fixture': {
                'package': 'aisdk:@ai-sdk/openai-compatible', 'name': 'Local fixture',
                'settings': {'baseURL': f'http://127.0.0.1:{provider.server_port}/v1', 'apiKey': 'fixture'},
                'models': {'fixture': {'name': 'Fixture', 'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']},
                                       'limit': {'context': 32000, 'output': 2048}}},
            }}, 'model': 'fixture/fixture',
        }))
        env = {k: v for k, v in os.environ.items() if not k.startswith(('OPENCODE_', 'CUSTOM_OPENCODE_', 'XDG_'))}
        env.update(HOME=str(home), TERM='xterm-256color', OPENCODE_DISABLE_AUTOUPDATE='1')
        for key, folder in [('CONFIG', '.config'), ('DATA', '.local/share'), ('STATE', '.local/state'), ('CACHE', '.cache')]:
            env[f'XDG_{key}_HOME'] = str(home / folder)
        process = None
        try:
            subprocess.run([binary, 'service', 'start'], env=env, cwd=project, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
            service = json.loads((home / '.local/state/opencode/service.json').read_text())
            headers = {'Authorization': 'Basic ' + base64.b64encode(('opencode:' + service['password']).encode()).decode(),
                       'Content-Type': 'application/json'}

            def api(method, path, body=None):
                with urlopen(Request(service['url'] + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode()), timeout=10) as response:
                    return json.load(response)

            session = api('POST', '/api/session', {'title': 'Escape regression', 'model': {'providerID': 'fixture', 'id': 'fixture'},
                                                   'location': {'directory': str(project)}})['data']
            sid = session['id']
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
            process = subprocess.Popen([binary, '--session', sid], env=env, cwd=project, stdin=slave, stdout=slave, stderr=slave)
            os.close(slave)

            def drain(seconds):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    if select.select([master], [], [], .02)[0]:
                        try:
                            os.read(master, 65536)
                        except OSError:
                            return

            drain(4)
            api('POST', f'/api/session/{sid}/prompt', {'text': 'Keep working.', 'files': []})
            assert started.wait(15), 'local provider never started'
            drain(1)
            begin = time.monotonic()
            os.write(master, b'\x1b')
            while time.monotonic() - begin < 4:
                drain(.05)
                state = api('GET', f'/api/session/{sid}')['data']
                if state.get('outcome') == 'interrupted':
                    break
            elapsed = (time.monotonic() - begin) * 1000
            assert state.get('outcome') == 'interrupted', f'single Escape did not stop: {state.get("outcome")}'
            assert disconnected.wait(1), 'provider stream is still alive'
            assert elapsed < 1000, f'Escape too slow: {elapsed:.1f} ms'
            print(json.dumps({'singleEscapeToIdleMs': round(elapsed, 1), 'providerDisconnected': True, 'paidCalls': 0}))
            os.close(master)
        except Exception:
            log = home / '.local/share/opencode/log/opencode.log'
            if log.exists():
                print(log.read_text()[-5000:])
            raise
        finally:
            if process is not None:
                process.terminate()
                process.wait(timeout=5)
            subprocess.run([binary, 'service', 'stop'], env=env, cwd=project, capture_output=True, timeout=20)
            provider.shutdown()


if __name__ == '__main__':
    main()

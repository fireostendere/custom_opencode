#!/usr/bin/env python3
"""Reject shell metacharacters before persisting web-server wizard settings."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('webserver_control_test', ROOT/'scripts/webserver-control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)

class BoundaryTests(unittest.TestCase):
    def test_host_rejects_shell_syntax_before_writing(self):
        for host in ['localhost;id', 'localhost\nINJECTED=yes', '$(id)', '`id`', 'localhost>file', 'localhost\t', 'a..b', '-localhost', 'a'*64+'.com']:
            with self.subTest(host=host), patch.object(control, '_rewrite_env_file') as write:
                with self.assertRaises(control.ControlError):
                    control.port_command(4098, host)
                write.assert_not_called()

    def test_valid_hosts(self):
        for host in ['localhost', '127.0.0.1', '0.0.0.0', 'my-host.example.com', 'my-host.example.com.']:
            with self.subTest(host=host), patch.object(control, '_rewrite_env_file') as write, patch.object(control, 'probe', return_value=''):
                self.assertTrue(control.port_command(4098, host)['ok'])
                write.assert_called_once_with(4098, host)

    def test_private_atomic_concurrent_state(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)/'webserver.json'
            with patch.dict(os.environ, {'OPENCODE_WEBSERVER_STATE':str(state)}):
                with ThreadPoolExecutor(max_workers=12) as pool:
                    list(pool.map(lambda i:control.write_state({'version':1,'writer':i}),range(60)))
            self.assertIn(json.loads(state.read_text())['writer'],range(60))
            self.assertEqual(state.stat().st_mode & 0o777,0o600)
            self.assertEqual(list(Path(tmp).glob('*.tmp')),[])

if __name__ == '__main__':
    unittest.main(verbosity=2)

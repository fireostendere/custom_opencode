#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "scripts" / "web-fixture-e2e.py"
spec = importlib.util.spec_from_file_location("web_fixture_e2e", TARGET)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load fixture E2E")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def debug_created_session(page, previous_hash: str, payload_count: int, directory: str) -> None:
    page.wait_for_function("document.querySelector('#projectDialog').open === false")
    deadline = time.monotonic() + 5.0
    samples = []
    while time.monotonic() < deadline:
        snapshot = page.evaluate("""() => ({
          hash: location.hash,
          active: document.querySelector('#sessions .session.active [data-session]')?.dataset.session || '',
          title: document.querySelector('#sessions .session.active .session-title')?.textContent || '',
          dialogOpen: document.querySelector('#projectDialog')?.open === true,
          toast: document.querySelector('#toast')?.textContent || ''
        })""")
        samples.append(snapshot)
        if snapshot["hash"] != previous_hash and snapshot["hash"].startswith("#/session/"):
            break
        time.sleep(0.1)
    final = samples[-1]
    print("NAVDEBUG", {"previous": previous_hash, "final": final, "payload_count": len(module.FixtureState.session_payloads), "expected_directory": directory}, flush=True)
    if not (final["hash"] != previous_hash and final["hash"].startswith("#/session/")):
        print("NAVDEBUG samples", samples[-10:], flush=True)
        raise AssertionError(f"session navigation did not change hash: {previous_hash!r} -> {final!r}")
    assert len(module.FixtureState.session_payloads) == payload_count + 1
    assert module.FixtureState.session_payloads[payload_count]["location"]["directory"] == directory


module.assert_created_session = debug_created_session
raise SystemExit(module.main())

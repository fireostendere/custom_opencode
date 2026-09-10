#!/usr/bin/env python3
"""Offline broker contract, lifecycle, policy and actual subprocess regressions."""
import asyncio
import copy
import json
import os
import site
import socket
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from jsonschema import ValidationError
from mcp import Client, StdioServerParameters, stdio_client
from tool_fabric import Fabric, digest, fingerprint, validate_manifest, load_config
from tool_fabric_mcp import make_server


FILE = {"type": "string", "format": "workspace-file"}
TEXT = {"type": "string", "minLength": 1, "maxLength": 4096}


def schema(properties=None, required=None):
    return {"type": "object", "additionalProperties": False, "properties": properties or {}, "required": required or []}


def recipe(argv, properties=None, required=None, *, risk="build", cache=False):
    return {"argv": argv, "inputSchema": schema(properties, required), "risk": risk,
            "network": False, "cache": cache, "timeoutSeconds": 300}


async def terminal(fabric, job):
    for _ in range(300):
        status = fabric.status(job["jobId"])
        if status["state"] not in {"queued", "running"}:
            return status
        await asyncio.sleep(.02)
    raise AssertionError("job did not finish")


async def main():
    with tempfile.TemporaryDirectory(prefix="fabric-smoke-") as temp:
        base = Path(temp)
        project = base / "project"
        project.mkdir()
        (project / "input.txt").write_text("test input\n")
        (project / "secret-link").symlink_to("/etc/passwd")
        assert "secret-link" not in fingerprint(project)["files"]
        engine = ROOT / "scripts/fixtures/tool-fabric-engine.py"
        fixture = {"schemaVersion": 1, "id": "fixture", "name": "Fixture", "source": "local fixture", "license": "MIT",
                   "kind": "cli", "binary": sys.executable, "categories": ["test"], "markers": ["*.txt"], "operations": {}, "fallbacks": []}
        for mode in ("ok", "sleep", "fail", "flood"):
            fixture["operations"][mode] = recipe([sys.executable, str(engine), mode, "{output}", "{value}"], {"value": TEXT}, ["value"], cache=mode == "ok")
        fixture["operations"]["file"] = recipe([sys.executable, str(engine), "ok", "{output}", "{file}"], {"file": FILE}, ["file"])
        fixture["operations"]["flash"] = recipe([sys.executable, str(engine), "ok", "{output}", "{device}"], {"device": TEXT}, ["device"], risk="device-write")
        fixture["operations"]["timeout"] = {**copy.deepcopy(fixture["operations"]["sleep"]), "timeoutSeconds": 1}
        config = {"tools": [fixture], "permissions": {"fixture": {"trustedHost": True, "cache": True, "toolchainDigest": digest("fixture-v1")}}}
        empty = Fabric(str(project), str(base / "empty"))
        assert empty.rows == {} and empty.search()["catalogSize"] == 0
        await empty.close()
        layer = base / "arbitrary-private-layer.json"
        layer.write_text(json.dumps({"tools": [fixture], "keywords": {"провер": "fixture"}}))
        operator = base / "operator.json"
        operator.write_text(json.dumps({"layers": [layer.name], "permissions": config["permissions"]}))
        config = load_config(operator, project)
        assert config["tools"] == [fixture]
        other = {**copy.deepcopy(fixture), "id": "unrelated-domain", "categories": ["arbitrary-domain"]}
        second = base / "second.json"
        second.write_text(json.dumps({"tools": [other]}))
        operator.write_text(json.dumps({"layers": [layer.name, second.name]}))
        assert [row["id"] for row in load_config(operator, project)["tools"]] == ["fixture", "unrelated-domain"]
        second.write_text(json.dumps({"tools": [fixture]}))
        try:
            load_config(operator, project)
            raise AssertionError("duplicate IDs across distinct layers accepted")
        except ValueError:
            pass
        try:
            load_config(ROOT / ".env.example", project)
            raise AssertionError("repository-local operator config accepted")
        except ValueError:
            pass
        for bad in ({"layers": [layer.name, layer.name]}, {"layers": ["project/policy.json"]}):
            (project / "policy.json").write_text("{}")
            operator.write_text(json.dumps(bad))
            try:
                load_config(operator, project)
                raise AssertionError("duplicate or workspace-controlled layer accepted")
            except ValueError:
                pass
        layer.write_text(json.dumps({"tools": [fixture], "permissions": {"fixture": {"trustedHost": True}}}))
        operator.write_text(json.dumps({"layers": [layer.name]}))
        try:
            load_config(operator, project)
            raise AssertionError("layer permission escalation accepted")
        except ValueError:
            pass
        layer.write_text(json.dumps({"tools": [fixture], "keywords": {"провер": "fixture"}}))
        operator.write_text(json.dumps({"layers": [layer.name], "permissions": config["permissions"]}))
        # No engine probes, imports, process creation or network at discovery time.
        with patch("subprocess.run", side_effect=AssertionError("discovery spawned subprocess")), patch("asyncio.create_subprocess_exec", side_effect=AssertionError("discovery spawned subprocess")):
            fabric = Fabric(str(project), str(base / "state"), config)
            assert len(fabric.rows) == 1
            assert fabric.search("проверить", include_unavailable=True)["results"][0]["id"] == "fixture"
            assert fabric.inspect(["fixture"])["tools"][0]["operations"]["flash"]["unavailableReason"]
            assert not fabric.active
        invalid = copy.deepcopy(fixture)
        invalid["operations"]["ok"]["inputSchema"]["additionalProperties"] = True
        try:
            validate_manifest(invalid)
            raise AssertionError("open-ended schema accepted")
        except ValueError:
            pass
        server = make_server(fabric)
        print("fabric: discovery validated", flush=True)
        async with Client(server) as client:
            assert [t.name for t in (await client.list_tools()).tools] == ["catalog.search", "catalog.inspect", "tool.run", "job.status", "job.cancel"]
            for file in ("../outside", "/etc/passwd", "secret-link"):
                try:
                    await fabric.run("fixture", "file", {"file": file})
                    raise AssertionError("unsafe input path accepted")
                except ValidationError:
                    pass
            assert not (await fabric.run("fixture", "flash", {"device": "probe-1"}, dry_run=True))["allowed"]
            try:
                await fabric.run("fixture", "flash", {"device": "probe-1"})
                raise AssertionError("unapproved flash accepted")
            except PermissionError:
                pass
            os.environ["FABRIC_TEST_SECRET"] = "must-not-inherit"
            payload = "; touch SHOULD_NOT_EXIST $(echo injected)"
            first = await fabric.run("fixture", "ok", {"value": payload}, idempotency_key="one")
            done = await terminal(fabric, first)
            print("fabric: first subprocess completed", flush=True)
            assert done["state"] == "completed", done
            value = json.loads(done["result"]["stdout"])
            assert value == {"args": [payload], "secretInherited": False}
            assert not (project / "SHOULD_NOT_EXIST").exists()
            assert len(done["result"]["artifacts"]) == 1
            again = await fabric.run("fixture", "ok", {"value": payload}, idempotency_key="one")
            assert again["jobId"] == first["jobId"]
            try:
                await fabric.run("fixture", "ok", {"value": "different"}, idempotency_key="one")
                raise AssertionError("conflicting idempotency key accepted")
            except ValueError:
                pass
            # Symlinks disable content caching instead of ignoring dependencies.
            assert not done["result"]["cacheHit"]
            (project / "secret-link").unlink()
            done = await terminal(fabric, await fabric.run("fixture", "ok", {"value": "cache"}))
            cached = await terminal(fabric, await fabric.run("fixture", "ok", {"value": "cache"}))
            assert cached["result"]["cacheHit"], cached
            (project / "input.txt").write_text("changed input\n")
            changed = await terminal(fabric, await fabric.run("fixture", "ok", {"value": "cache"}))
            assert not changed["result"]["cacheHit"]
            ref = changed["result"]["artifacts"][0]
            with fabric.store.connect() as db:
                path = db.execute("SELECT file_path FROM artifacts WHERE id=?", (ref["id"],)).fetchone()[0]
            Path(path).write_bytes(b"corrupt")
            assert not fabric._cache_valid(changed["result"])
            flood = await terminal(fabric, await fabric.run("fixture", "flood", {"value": "flood"}))
            assert flood["result"]["outputTruncated"]
            assert len(flood["result"]["stdout"]) <= 48000 and len(flood["result"]["stderr"]) <= 48000
            failed = await terminal(fabric, await fabric.run("fixture", "fail", {"value": "fail"}))
            assert failed["state"] == "failed" and failed["result"]["exitCode"] == 7
            timed = await terminal(fabric, await fabric.run("fixture", "timeout", {"value": "timeout"}))
            assert timed["state"] == "failed" and "TimeoutError" in timed["error"]
            try:
                await fabric.run("fixture", "timeout", {"value": "timeout"})
                raise AssertionError("negative cache ignored")
            except RuntimeError:
                pass
            jobs = [await fabric.run("fixture", "sleep", {"value": str(i)}) for i in range(4)]
            print("fabric: cache/output/timeout validated", flush=True)
            await asyncio.sleep(.1)
            assert sum(fabric.status(j["jobId"])["state"] == "running" for j in jobs) == 3
            for job in jobs:
                assert (await fabric.cancel(job["jobId"]))["state"] == "cancelled"
            # Restart recovery preserves a durable handle without replay.
            interrupted = fabric.store.create_task(session_id="tool-fabric", project_dir=str(project), kind="tool-fabric", metadata={"toolId": "fixture", "operation": "sleep"})
        reopened = Fabric(str(project), str(base / "state"), config)
        print("fabric: in-memory MCP closed", flush=True)
        reopened.start()
        assert reopened.status(interrupted["id"])["state"] == "needs_attention"
        assert reopened.status(first["jobId"])["state"] == "completed"
        await reopened.close()

        # Real bubblewrap isolation. Run outside a nesting-restricted agent sandbox.
        outside = base / "operator-secret"
        outside.write_text("not visible to the tool")
        sandboxed = copy.deepcopy(fixture)
        sandboxed["id"] = "sandboxed"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = str(listener.getsockname()[1])
            sandboxed["operations"] = {"check": recipe([sys.executable, str(engine), "sandbox", "{output}", str(outside), port])}
            sandbox_config = {"tools": [sandboxed], "permissions": {"sandboxed": {"runtimeRoots": [str(engine.parent)]}}}
            isolated = Fabric(str(project), str(base / "isolated"), sandbox_config)
            isolated.start()
            try:
                result = await terminal(isolated, await isolated.run("sandboxed", "check"))
                assert result["state"] == "completed", result
                assert json.loads(result["result"]["stdout"]) == {"outsideReadable": False, "sourceWritable": False, "hostNetworkAccessible": False}
                assert len(result["result"]["artifacts"]) == 1, "artifact symlink must not be collected"
            finally:
                await isolated.close()
        print("fabric: real filesystem/network sandbox validated", flush=True)

        # Wire-level subprocess acceptance, no inference or installed engines.
        params = StdioServerParameters(command=sys.executable, args=[str(ROOT / "app/tool_fabric_mcp.py"), "--workspace", str(project), "--state-dir", str(base / "wire"), "--config", str(operator)], env={"PYTHONPATH": os.environ.get("PYTHONPATH", "")})
        for mode in ("auto", "legacy"):
            print(f"fabric: wire {mode}", flush=True)
            async with Client(stdio_client(params), mode=mode) as client:
                assert len((await client.list_tools()).tools) == 5
                result = await client.call_tool("catalog.inspect", {"toolIds": ["fixture"]})
                assert not result.is_error, result

        # A real upstream process: pin its schema then run through our facade.
        upstream_params = StdioServerParameters(command=sys.executable, args=[str(ROOT / "scripts/fixtures/tool-fabric-upstream.py")])
        print("fabric: upstream federation", flush=True)
        async with Client(stdio_client(upstream_params)) as client:
            upstream_schema = (await client.list_tools()).tools[0].input_schema
        native = {**fixture, "id": "native", "kind": "mcp", "runtime": {"command": [sys.executable, str(ROOT / "scripts/fixtures/tool-fabric-upstream.py")]},
                  "operations": {"echo": {"inputSchema": schema({"value": TEXT}, ["value"]), "upstreamSchemaDigest": digest(upstream_schema), "risk": "read", "network": False, "tool": "echo"}}}
        # This test can run with a user-site SDK; production uses a dedicated venv.
        os.environ["PYTHONPATH"] = os.pathsep.join([site.getusersitepackages(), os.environ.get("PYTHONPATH", "")])
        native_config = {"tools": [native], "permissions": {"native": {"trustedHost": True, "environment": ["PYTHONPATH"]}}}
        native_fabric = Fabric(str(project), str(base / "native"), native_config)
        async with Client(make_server(native_fabric)):
            done = await terminal(native_fabric, await native_fabric.run("native", "echo", {"value": "hello"}))
            assert done["state"] == "completed", done
            assert "hello" in done["result"]["stdout"]
            native_fabric.rows["native"]["operations"]["echo"]["upstreamSchemaDigest"] = "changed"
            drift = await terminal(native_fabric, await native_fabric.run("native", "echo", {"value": "hello"}))
            assert drift["state"] == "failed", drift
            native_fabric.rows["native"]["operations"]["echo"]["upstreamSchemaDigest"] = digest(upstream_schema)
            bomb = await terminal(native_fabric, await native_fabric.run("native", "echo", {"value": "bomb"}))
            assert bomb["state"] == "failed", "oversized upstream JSON must fail before unbounded parsing"

    print("Tool Fabric passed: offline discovery, 5 MCP tools, modern/legacy stdio, real CLI/upstream execution, schema drift, policy, paths, cache, idempotency, limits, cancellation, restart")


if __name__ == "__main__":
    asyncio.run(main())

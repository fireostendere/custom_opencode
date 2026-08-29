#!/usr/bin/env python3
"""Production web entrypoint composing RAG and advanced workflow features."""
from __future__ import annotations

import json
from typing import Any

import server_features as features
import server_rag as rag


class Handler(rag.Handler, features.Handler):
    """RAG routes first, then persistent workflow routes, then the base proxy."""

    def json_response(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    rag.plus.ext.base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = rag.plus.ext.base.ThreadingHTTPServer((rag.plus.ext.base.WEB_HOST, rag.plus.ext.base.WEB_PORT), Handler)
    features._ensure_worker()
    print(f"OpenCode web client started on configured port {rag.plus.ext.base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

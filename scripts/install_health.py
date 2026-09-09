"""HTTP authentication shared by post-install checks; never enables Basic auth."""
from __future__ import annotations

import http.client
from http.cookies import SimpleCookie
import json
from typing import Any


def web_auth_headers(base: Any) -> dict[str, str]:
    """Obtain a short-lived web session using the normal login endpoint."""
    host = str(base.WEB_HOST).strip("[]")
    if host in {"0.0.0.0", "::"}:
        host = "localhost"
    connection = http.client.HTTPConnection(host, int(base.WEB_PORT), timeout=5)
    try:
        body = json.dumps({"username": base.CLIENT_USER, "password": base.CLIENT_PASSWORD, "remember": False})
        connection.request("POST", "/auth/login", body=body.encode("utf-8"), headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        response.read(8192)
        if response.status != 204:
            raise RuntimeError(f"self-test login failed: HTTP {response.status}")
        cookies = SimpleCookie()
        cookies.load(response.getheader("Set-Cookie", ""))
        cookie = cookies.get("opencode_session")
        if cookie is None or not cookie.value:
            raise RuntimeError("self-test login returned no session cookie")
        return {"Cookie": f"opencode_session={cookie.value}", "Accept": "application/json"}
    finally:
        connection.close()

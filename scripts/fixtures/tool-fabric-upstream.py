"""Real SDK subprocess upstream for modern and legacy MCP regression tests."""
from mcp.server import MCPServer

server = MCPServer("fabric-fixture")

@server.tool()
def echo(value: str) -> str:
    if value == "bomb":
        return "x" * 2_000_000
    return value

if __name__ == "__main__":
    server.run(transport="stdio")

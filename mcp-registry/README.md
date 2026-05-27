# Official MCP Registry artifact

This directory contains the canonical `server.json` published to the
[Official MCP Registry](https://registry.modelcontextprotocol.io) at
`io.github.hshintelligence/agent-scrape`.

## Re-publish on version bump

```bash
brew install mcp-publisher        # one-time install
mcp-publisher login github         # OAuth via github.com/login/device
# bump "version" in server.json to match the new agent-scrape release
mcp-publisher validate
mcp-publisher publish
```

## Verify

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=agent-scrape" | python3 -m json.tool
```

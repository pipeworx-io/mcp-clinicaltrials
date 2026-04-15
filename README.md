# mcp-clinicaltrials

ClinicalTrials MCP — wraps ClinicalTrials.gov API v2 (free, no auth)

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "clinicaltrials": {
      "url": "https://gateway.pipeworx.io/clinicaltrials/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use clinicaltrials
```

## License

MIT

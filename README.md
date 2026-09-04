# mcp-odoo-architect

MCP server (stdio) for scoping safe Odoo add-ons from Claude Desktop, Codex, OpenCode, or any MCP client. Deterministic local composer — no API keys, no network.

Separate from the [WebMCP Challenge entry](https://github.com/omersx/odoo-architect-webmcp) (browser UI + approval gate). Same engine, headless form.

## Tools

- `draft_plan` — 4-section architecture plan from a business requirement
- `generate_addon` — 11-file Odoo starter (manifest, models, views, security, tests, README)
- `validate_addon` — 7 static checks over the starter
- `save_addon` — generate + write all files to `output_dir/<module>/` on disk
- `explain_tradeoffs` — risks, rejected alternatives, why upgrade-safe
- `list_presets` — 4 demo briefs (urgency, pharmacy, POS discount, Shopify bridge)

Starters are review scaffolds, not production code: review + staging Odoo install first.

## Install

```bash
cd mcp-odoo-architect
npm install
```

Claude Desktop (`claude_desktop_config.json`), Codex (`config.toml` uses same JSON), OpenCode (`opencode.json` → `mcp`):

```json
{
  "mcpServers": {
    "odoo-architect": {
      "command": "node",
      "args": ["C:/Users/Wad Yonis/Desktop/webmcp1/mcp-odoo-architect/index.js"]
    }
  }
}
```

Use an absolute path to `index.js` on your machine. Restart the client after saving.

## Test

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).

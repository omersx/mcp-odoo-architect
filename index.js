#!/usr/bin/env node
// mcp-odoo-architect: MCP server (stdio) exposing Odoo scoping tools.
// Install via mcpServers JSON in Claude Desktop / Codex / OpenCode. No keys needed.
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const odoo = require("./lib/odoo");

const server = new Server({ name: "mcp-odoo-architect", version: "0.1.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "draft_plan",
    description: "Turn a business requirement into a reviewable 4-section Odoo addon architecture plan (scope, model, views/access, quality gate).",
    inputSchema: {
      type: "object",
      properties: {
        requirement: { type: "string", description: "Business outcome, not implementation." },
        guardrails: { type: "array", items: { type: "string" }, description: "Optional extra constraints." },
        odoo_version: { type: "string", description: "Odoo version, e.g. 18.0. Default 18.0." }
      },
      required: ["requirement"]
    }
  },
  {
    name: "generate_addon",
    description: "Generate an 11-file Odoo addon starter (manifest, models, views, security, tests, README) composed from the requirement. Starter only — review + staging install before production.",
    inputSchema: {
      type: "object",
      properties: {
        requirement: { type: "string", description: "Business outcome the starter implements." },
        guardrails: { type: "array", items: { type: "string" } },
        odoo_version: { type: "string" }
      },
      required: ["requirement"]
    }
  },
  {
    name: "validate_addon",
    description: "Run the 7 static checks (module name, manifest deps, ORM use, XML, access rights, tests, guardrails) over generated files.",
    inputSchema: {
      type: "object",
      properties: {
        requirement: { type: "string" },
        guardrails: { type: "array", items: { type: "string" } }
      },
      required: ["requirement"]
    }
  },
  {
    name: "explain_tradeoffs",
    description: "Explain risks, rejected alternatives, and why the plan is upgrade-safe.",
    inputSchema: {
      type: "object",
      properties: {
        requirement: { type: "string" },
        guardrails: { type: "array", items: { type: "string" } }
      },
      required: ["requirement"]
    }
  },
  {
    name: "list_presets",
    description: "List the 4 built-in demo briefs (urgency, pharmacy, POS discount, Shopify bridge).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "save_addon",
    description: "Generate the starter and write all files to output_dir/<module>/ on disk. Returns directory, tree, and validation.",
    inputSchema: {
      type: "object",
      properties: {
        requirement: { type: "string" },
        output_dir: { type: "string", description: "Existing parent directory, e.g. ./custom_addons" },
        guardrails: { type: "array", items: { type: "string" } },
        odoo_version: { type: "string" }
      },
      required: ["requirement", "output_dir"]
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};
  try {
    if (name === "draft_plan") {
      const plan = odoo.buildPlan(a.requirement, a.guardrails, a.odoo_version);
      return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
    }
    if (name === "generate_addon") {
      const gen = odoo.generateAddon(a.requirement, a.guardrails, a.odoo_version);
      return { content: [{ type: "text", text: JSON.stringify({ module: gen.module, scenario: gen.scenario, tree: gen.tree, validation: gen.validation, files: gen.files }, null, 2) }] };
    }
    if (name === "validate_addon") {
      const gen = odoo.generateAddon(a.requirement, a.guardrails, a.odoo_version);
      return { content: [{ type: "text", text: JSON.stringify({ module: gen.module, validation: gen.validation }, null, 2) }] };
    }
    if (name === "explain_tradeoffs") {
      return { content: [{ type: "text", text: JSON.stringify(odoo.explainTradeoffs(a.requirement, a.guardrails), null, 2) }] };
    }
    if (name === "list_presets") {
      return { content: [{ type: "text", text: JSON.stringify(odoo.PRESETS, null, 2) }] };
    }
    if (name === "save_addon") {
      const saved = odoo.saveAddon(a.requirement, a.output_dir, a.guardrails, a.odoo_version);
      const summary = { module: saved.module, scenario: saved.scenario, directory: saved.directory, files: saved.files, tree: saved.tree, validation: saved.validation };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

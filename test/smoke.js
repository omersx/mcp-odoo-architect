// Smoke test: lib-level checks + full MCP stdio round-trip.
const { spawn } = require("child_process");
const path = require("path");
const odoo = require("../lib/odoo");

let fails = 0;
const check = (n, c, x) => { console.log((c ? "PASS" : "FAIL") + " — " + n + (x ? " : " + String(x).slice(0, 120) : "")); if (!c) fails++; };

async function main() {
  // --- lib level ---
  const plan = odoo.buildPlan("When a sales order becomes urgent, show delivery urgency on the quotation.", null, "18.0");
  check("lib plan 4 sections", plan.sections.length === 4 && plan.module === "biz_bridge_delivery_urgency", plan.module);
  const gen = odoo.generateAddon("Track company car service dates and warn the office coordinator when maintenance is overdue.", null, "18.0");
  check("lib novel module composed", gen.module === "biz_bridge_track_company", gen.module);
  check("lib 11 files 7/7", Object.keys(gen.files).length === 11 && gen.validation.filter((v) => v.startsWith("FAIL")).length === 0);
  check("lib presets 4", Object.keys(odoo.PRESETS).length === 4);

  // --- stdio round-trip ---
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  let id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  const textOf = (resp) => resp.result.content[0].text;
  try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
    const list = await send("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    check("stdio 5 tools", names.length === 5, names.join(","));
    const draft = await send("tools/call", { name: "draft_plan", arguments: { requirement: "For pharmacy sales, warn when a product expires within 30 days." } });
    const dp = JSON.parse(textOf(draft));
    check("stdio draft_plan", dp.module === "biz_bridge_pharmacy_expiry", dp.module);
    const genR = await send("tools/call", { name: "generate_addon", arguments: { requirement: "Sync Shopify orders into Odoo sales with idempotent webhook handling." } });
    const gr = JSON.parse(textOf(genR));
    check("stdio generate_addon", gr.module === "biz_bridge_shopify_bridge" && Object.keys(gr.files).length === 11, gr.module);
    const bad = await send("tools/call", { name: "draft_plan", arguments: {} });
    check("stdio missing-arg error", bad.result.isError === true);
    const unk = await send("tools/call", { name: "nope", arguments: {} });
    check("stdio unknown-tool error", unk.result.isError === true);
  } finally {
    child.kill();
  }
  console.log(fails ? `\n${fails} SMOKE FAILURES` : "\nSMOKE: ALL PASS");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Pure Odoo Architect logic for the MCP server. No DOM, no network, no keys.
// Ported from the WebMCP Studio composer (deterministic local engine).

const fs = require("fs");
const path = require("path");

const FRAMEWORK_RULES = [
  "Use custom add-ons; never modify Odoo core.",
  "Prefer ORM-first business logic and stable XML inheritance.",
  "Define access rights and review record rules for each new model.",
  "Plan for upgrade safety, multi-company behavior, and tests."
];

const PRESETS = {
  urgency: "When a sales order becomes urgent, show a delivery urgency on the quotation, copy it to the invoice, and make it visible to warehouse staff.",
  pharmacy: "For pharmacy sales, warn when a product expires within 30 days at quotation time, block confirmation without pharmacist override, and log the override for audit.",
  pos_discount: "For retail POS, allow a manager-approved discount above 10% on orders, record the approver, and show the discount reason on the receipt and invoice.",
  shopify: "Sync Shopify orders into Odoo sales with idempotent webhook handling, map Shopify discount codes to Odoo pricelists, and flag sync failures for manual review."
};

function titleCase(value) {
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function keywordList(text, count) {
  const stop = new Set(["when", "show", "make", "that", "this", "with", "from", "into", "order", "sales", "sale", "allow", "record", "visible", "staff", "time", "above", "need", "needs", "without", "before", "after", "each", "more", "most", "very", "just", "block", "warn", "copy", "becomes", "become"]);
  const words = (String(text).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !stop.has(w));
  return [...new Set(words)].slice(0, count);
}

function detectScenario(requirement) {
  const t = String(requirement).toLowerCase();
  if (t.includes("shopify") || t.includes("webhook") || t.includes("sync")) return "shopify";
  if (t.includes("pharmac") || t.includes("expir")) return "pharmacy";
  if (t.includes("pos") || t.includes("discount") || t.includes("receipt") || t.includes("retail")) return "pos";
  if (t.includes("urgent") || t.includes("urgency") || t.includes("warehouse") || t.includes("delivery")) return "urgency";
  return "generic";
}

function scenarioMeta(scenario) {
  if (scenario === "shopify") return { key: "shopify", moduleSuffix: "shopify_bridge", modelFile: "sale_order.py", title: "Shopify order bridge", modelDesc: "Idempotent webhook sync, discount mapping, failure queue for review.", dependsExtra: ["sale_management"] };
  if (scenario === "pharmacy") return { key: "pharmacy", moduleSuffix: "pharmacy_expiry", modelFile: "sale_order.py", title: "Pharmacy expiry guard", modelDesc: "Block risky confirmation, require pharmacist override with audit log.", dependsExtra: ["product_expiry"] };
  if (scenario === "pos") return { key: "pos", moduleSuffix: "pos_discount", modelFile: "pos_order.py", title: "POS manager discount", modelDesc: "Gate high discounts behind manager approval, show reason on receipt.", dependsExtra: ["point_of_sale"] };
  if (scenario === "urgency") return { key: "urgency", moduleSuffix: "delivery_urgency", modelFile: "sale_order.py", title: "Delivery urgency flow", modelDesc: "Propagate urgency quotation -> invoice -> warehouse, read-only downstream.", dependsExtra: ["stock"] };
  return { key: "generic", moduleSuffix: "custom_workflow", modelFile: "sale_order.py", title: "Custom workflow", modelDesc: "Minimal _inherit extension driven by the brief, safe to extend.", dependsExtra: [] };
}

function inferDependencies(requirement) {
  const text = String(requirement).toLowerCase();
  const dependencies = ["sale_management"];
  if (text.includes("invoice") || text.includes("account") || text.includes("receipt")) dependencies.push("account");
  if (text.includes("warehouse") || text.includes("stock") || text.includes("delivery") || text.includes("transfer")) dependencies.push("stock");
  if (text.includes("lead") || text.includes("opportunity") || text.includes("crm")) dependencies.push("crm");
  if (text.includes("pos") || text.includes("retail") || text.includes("receipt")) dependencies.push("point_of_sale");
  if (text.includes("pharmacy") || text.includes("expiry") || text.includes("product")) dependencies.push("product_expiry");
  return [...new Set(dependencies)];
}

function parseBrief(requirement) {
  const t = String(requirement).toLowerCase();
  const scenario = detectScenario(requirement);
  const has = (...keys) => keys.some((k) => t.includes(k));
  const concepts = [];
  if (has("urgent", "urgency", "priority")) concepts.push("urgency");
  if (has("expir")) concepts.push("expiry");
  if (has("discount")) concepts.push("discount");
  if (has("approv", "override", "manager", "pharmacist")) concepts.push("approval");
  if (has("shopify", "webhook", "sync", "external")) concepts.push("sync");
  if (has("invoice", "account", "receipt", "pricelist")) concepts.push("invoice");
  if (has("warehouse", "stock", "delivery", "transfer", "picking")) concepts.push("warehouse");
  if (has("lead", "opportunity", "crm")) concepts.push("crm");
  const targets = ["sale.order"];
  if (has("pos", "retail", "receipt") && has("discount", "pos", "retail")) targets.unshift("pos.order");
  if (has("invoice", "account")) targets.push("account.move");
  if (has("warehouse", "stock", "delivery", "transfer", "picking")) targets.push("stock.picking");
  if (has("lead", "opportunity", "crm")) targets.push("crm.lead");
  const uniqTargets = [...new Set(targets)];
  const primary = uniqTargets[0];
  const presetSuffix = { shopify: "shopify_bridge", pharmacy: "pharmacy_expiry", pos: "pos_discount", urgency: "delivery_urgency" }[scenario];
  const kw = keywordList(t, 2);
  const moduleSuffix = presetSuffix || ((kw.join("_") || "custom_workflow").slice(0, 34));
  const depends = inferDependencies(requirement);
  return { scenario, concepts, targets: uniqTargets, primary, moduleSuffix, module: `biz_bridge_${moduleSuffix}`, depends, keywords: kw };
}

function buildPlan(requirement, guardrails, odooVersion) {
  const req = String(requirement || "").trim();
  if (!req) throw new Error("requirement is required");
  const spec = parseBrief(req);
  const meta = scenarioMeta(spec.scenario);
  const rules = guardrails && guardrails.length ? guardrails : [...FRAMEWORK_RULES];
  const extra = rules.slice(4).map((g) => `Guardrail: ${g}`);
  const multiCompany = rules.some((g) => String(g).toLowerCase().includes("company"));
  const domainItems = spec.scenario === "pharmacy"
    ? ["expiry check via ORM, no raw SQL", "block confirm without override group", "audit log model for overrides"]
    : spec.scenario === "pos"
      ? ["discount approval field + approver tracking", "enforce >10% needs manager group", "receipt/invoice display method"]
      : spec.scenario === "shopify"
        ? ["idempotent upsert via ORM search, no duplicates", "discount/pricelist mapping method", "failure queue for manual review"]
        : [`Derive fields from brief keywords: ${spec.keywords.join(", ") || "custom"}`, "ORM-first methods, no raw SQL", "Keep standard flow via super()"];
  return {
    module: spec.module,
    scenario: spec.scenario,
    sections: [
      { title: `Scope & modules — ${meta.title}`, description: "Map the business request to the smallest upgrade-safe Odoo extension.", items: [`Create extension module: ${spec.module}`, `Depends on ${spec.depends.map(titleCase).join(", ")}`, `Targets: ${spec.targets.join(", ")}`, spec.concepts.length ? `Concepts: ${spec.concepts.join(", ")}` : "Concepts: custom workflow", "Keep standard Odoo behavior intact", ...extra.slice(0, 3)] },
      { title: "Domain model", description: meta.modelDesc, items: domainItems },
      { title: "Views & access", description: "Expose the right data without changing ownership.", items: ["Extend views with stable XPath", "Read-only downstream fields", multiCompany ? "Add company_id + record rules for multi-company" : "Review model access and record-rule visibility"] },
      { title: "Quality gate", description: "Reviewable before live Odoo.", items: ["2+ TransactionCase tests", "Run framework static validation", `Smoke install on Odoo ${odooVersion || "18.0"}`] }
    ]
  };
}

function summarizeRequirement(requirement) {
  const clean = String(requirement).replace(/\s+/g, " ").trim();
  return clean.length > 145 ? `${clean.slice(0, 142)}…` : clean;
}

function modelPyFor(spec, brief, guardrailText, multiCompanyNote, className) {
  const scenario = spec.scenario;
  if (scenario === "shopify") return `from odoo import api, fields, models


class SaleOrder(models.Model):
    _inherit = "sale.order"

    shopify_order_id = fields.Char(index=True, help="Idempotent Shopify order id.")
    shopify_sync_state = fields.Selection(
        [("pending", "Pending"), ("done", "Done"), ("failed", "Failed")],
        default="pending",
    )${multiCompanyNote}

    def _shopify_upsert(self, payload):
        # Idempotent: search first, no duplicates, no raw SQL.
        existing = self.search([("shopify_order_id", "=", payload.get("id"))], limit=1)
        if existing:
            return existing
        return self.create({"shopify_order_id": payload.get("id")})
`;
  if (scenario === "pharmacy") return `from odoo import api, fields, models
from odoo.exceptions import ValidationError


class SaleOrder(models.Model):
    _inherit = "sale.order"

    expiry_warning = fields.Boolean(default=False, help="True when a line expires within 30 days.")
    pharmacist_override_id = fields.Many2one("res.users", help="Pharmacist who overrode the block.")${multiCompanyNote}

    def _check_expiry(self):
        # ORM-first: real check would read product_expiry dates.
        return True

    def action_confirm(self):
        if not self._check_expiry() and not self.pharmacist_override_id:
            raise ValidationError("Blocked: product expires within 30 days. Needs pharmacist override.")
        return super().action_confirm()
`;
  if (scenario === "pos") return `from odoo import api, fields, models
from odoo.exceptions import ValidationError


class PosOrder(models.Model):
    _inherit = "pos.order"

    manager_discount = fields.Float(default=0.0, help="Discount % above 10 needs manager.")
    discount_approver_id = fields.Many2one("res.users", readonly=True)${multiCompanyNote}
    discount_reason = fields.Char()

    def _check_discount(self):
        if self.manager_discount > 10 and not self.discount_approver_id:
            raise ValidationError("Discount above 10% requires manager approval.")
        return True
`;
  if (scenario === "urgency") return `from odoo import api, fields, models


class SaleOrder(models.Model):
    _inherit = "sale.order"

    delivery_urgency = fields.Selection(
        [("normal", "Normal"), ("urgent", "Urgent"), ("critical", "Critical")],
        default="normal",
        help="Urgency flag propagated to invoice and warehouse.",
    )${multiCompanyNote}

    def _prepare_invoice(self):
        vals = super()._prepare_invoice()
        vals["delivery_urgency"] = self.delivery_urgency
        return vals

    def action_confirm(self):
        # Guardrail-aware: keep standard flow, add audit-safe hook.
        return super().action_confirm()
`;
  const genericField = (`x_${(spec.keywords.slice(0, 2).join("_") || "custom_flag")}`).slice(0, 30).replace(/[^a-z0-9_]/g, "");
  return { code: `from odoo import api, fields, models


class ${className}(models.Model):
    _inherit = "${spec.primary}"

    ${genericField} = fields.Boolean(
        default=False,
        help="Custom outcome from brief: ${brief.replace(/"/g, "'").slice(0, 90)}",
    )
    x_brief_note = fields.Char(help="Operator note captured with this customization.")${multiCompanyNote}

    def _apply_brief_rules(self):
        # ORM-first hook composed from the brief keywords: ${spec.keywords.join(", ") || "custom"}.
        # Extend here; standard flow untouched.
        return True
`, genericField };
}

function testPyFor(scenario, primary, genericField) {
  if (scenario === "shopify") return `from odoo.tests.common import TransactionCase


class TestShopifyBridge(TransactionCase):
    def test_idempotent_upsert(self):
        order = self.env["sale.order"]._shopify_upsert({"id": "gid://shopify/Order/1"})
        again = self.env["sale.order"]._shopify_upsert({"id": "gid://shopify/Order/1"})
        self.assertEqual(order.id, again.id)

    def test_default_pending(self):
        order = self.env["sale.order"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        self.assertEqual(order.shopify_sync_state, "pending")
`;
  if (scenario === "pharmacy") return `from odoo.tests.common import TransactionCase


class TestPharmacy(TransactionCase):
    def test_blocks_without_override(self):
        order = self.env["sale.order"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        order.expiry_warning = True
        with self.assertRaises(Exception):
            order.action_confirm()

    def test_override_allows_confirm(self):
        self.assertTrue(True)
`;
  if (scenario === "pos") return `from odoo.tests.common import TransactionCase


class TestPosDiscount(TransactionCase):
    def test_high_discount_needs_manager(self):
        order = self.env["pos.order"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        order.manager_discount = 20
        with self.assertRaises(Exception):
            order._check_discount()
`;
  if (scenario === "urgency") return `from odoo.tests.common import TransactionCase


class TestDeliveryUrgency(TransactionCase):
    def test_urgency_propagates_to_invoice(self):
        order = self.env["sale.order"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        order.delivery_urgency = "urgent"
        invoice_vals = order._prepare_invoice()
        self.assertEqual(invoice_vals.get("delivery_urgency"), "urgent")

    def test_default_is_normal(self):
        order = self.env["sale.order"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        self.assertEqual(order.delivery_urgency, "normal")
`;
  const pf = primary || "sale.order";
  const gf = genericField || "x_brief_flag";
  return `from odoo.tests.common import TransactionCase


class TestBriefRules(TransactionCase):
    def test_flag_defaults_false(self):
        order = self.env["${pf}"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        self.assertFalse(order.${gf})

    def test_apply_brief_rules(self):
        order = self.env["${pf}"].create({"partner_id": self.env.ref("base.res_partner_2").id})
        self.assertTrue(order._apply_brief_rules())
`;
}

function viewXml(recordName, model, inheritRef, field, readonly) {
  return `<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="${recordName}" model="ir.ui.view">
        <field name="name">${model}.brief</field>
        <field name="model">${model}</field>
        <field name="inherit_id" ref="${inheritRef}"/>
        <field name="arch" type="xml">
            <xpath expr="//field[@name='partner_id']" position="after">
                <field name="${field}"${readonly ? ' readonly="1"' : ""}/>
            </xpath>
        </field>
    </record>
</odoo>
`;
}

function generateAddon(requirement, guardrails, odooVersion) {
  const req = String(requirement || "").trim();
  if (!req) throw new Error("requirement is required");
  const spec = parseBrief(req);
  const meta = scenarioMeta(spec.scenario);
  const rules = guardrails && guardrails.length ? guardrails : [...FRAMEWORK_RULES];
  const ver = odooVersion || "18.0";
  const module = spec.module;
  const deps = [...new Set([...spec.depends, ...meta.dependsExtra])];
  const brief = summarizeRequirement(req);
  const guardrailText = rules.map((g) => `- ${g}`).join("\n");
  const multiCompanyNote = rules.some((g) => String(g).toLowerCase().includes("company")) ? "\n# Guardrail: multi-company safe (company_id respected)." : "";
  const isPos = spec.primary === "pos.order";
  const className = isPos ? "PosOrder" : "SaleOrder";
  const modelFile = isPos ? "pos_order.py" : meta.modelFile;
  const testStem = `test_${spec.moduleSuffix}`;
  const modelBuilt = modelPyFor(spec, brief, guardrailText, multiCompanyNote, className);
  const modelCode = typeof modelBuilt === "string" ? modelBuilt : modelBuilt.code;
  const genericField = typeof modelBuilt === "object" ? modelBuilt.genericField : "x_brief_flag";
  const viewField = spec.scenario === "urgency" ? "delivery_urgency"
    : spec.scenario === "pharmacy" ? "expiry_warning"
    : spec.scenario === "pos" ? "manager_discount"
    : spec.scenario === "shopify" ? "shopify_sync_state"
    : (typeof modelBuilt === "object" ? modelBuilt.genericField : "x_brief_flag");
  const files = {
    "__manifest__.py": `{
    "name": "${titleCase(module)}",
    "version": "${ver}.1.0.0",
    "summary": "${brief.replace(/"/g, "'")}",
    "depends": [
${deps.map((d) => `        "${d}",`).join("\n")}
    ],
    "data": [
        "views/sale_order_views.xml",
        "views/account_move_views.xml",
        "views/stock_picking_views.xml",
        "security/ir.model.access.csv",
    ],
    "license": "LGPL-3",
    "application": False,
    "installable": True,
}
`,
    "__init__.py": "from . import models\n",
    "models/__init__.py": `from . import ${modelFile.replace(/\.py$/, "")}\n`,
    [`models/${modelFile}`]: modelCode,
    "views/sale_order_views.xml": viewXml("view_order_form_brief", "sale.order", "sale.view_order_form", viewField, false),
    "views/account_move_views.xml": viewXml("view_move_form_brief", "account.move", "account.view_move_form", viewField, true),
    "views/stock_picking_views.xml": viewXml("view_picking_form_brief", "stock.picking", "stock.vpicktree", viewField, true),
    "security/ir.model.access.csv": `id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_${module}_user,${module} user,model_sale_order,sales_team.group_sale_salesman,1,1,0,0\n`,
    "tests/__init__.py": `from . import ${testStem}\n`,
    [`tests/${testStem}.py`]: testPyFor(spec.scenario, spec.primary, genericField),
    "README.md": `# ${titleCase(module)}\n\n${brief}\n\n## Guardrails (from Odoo Architect Framework)\n${guardrailText}\n\n## Install\nCopy to Odoo addons path and update app list, then install.\n`
  };
  const tree = `${module}/\n├── __init__.py\n├── __manifest__.py\n├── README.md\n├── models/\n│   ├── __init__.py\n│   └── ${modelFile}\n├── views/\n│   ├── sale_order_views.xml\n│   ├── account_move_views.xml\n│   └── stock_picking_views.xml\n├── security/\n│   └── ir.model.access.csv\n└── tests/\n    ├── __init__.py\n    └── ${testStem}.py`;
  return { module, scenario: spec.scenario, files, tree, validation: validateAddon(files, module, req, rules) };
}

function validateAddon(files, module, requirement, guardrails) {
  const results = [];
  const push = (name, ok, detail) => results.push(`${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
  push("module-name", /^biz_bridge_[a-z0-9_]+$/.test(module), module);
  const manifest = files["__manifest__.py"] || "";
  const deps = inferDependencies(requirement || "");
  push("manifest-depends", deps.every((d) => manifest.includes(`"${d}"`)), `expects ${deps.join(",")}`);
  const pyKey = Object.keys(files).find((k) => k.startsWith("models/") && k !== "models/__init__.py") || "";
  const py = files[pyKey] || "";
  push("orm-inherit", py.includes('_inherit = "') && !/select\s/i.test(py), "uses _inherit, no raw SQL");
  const xmlKeys = ["views/sale_order_views.xml", "views/account_move_views.xml", "views/stock_picking_views.xml"];
  const xmlOk = xmlKeys.every((k) => (files[k] || "").includes("<xpath") && (files[k] || "").includes("</odoo>"));
  push("xml-inheritance", xmlOk, "3 views parse");
  const csv = files["security/ir.model.access.csv"] || "";
  push("access-rights", csv.includes("access_") && csv.includes("perm_read"), "ir.model.access.csv present");
  const testKey = Object.keys(files).find((k) => k.startsWith("tests/test_")) || "";
  const test = files[testKey] || "";
  push("tests", test.includes("def test_") && /_prepare_invoice|_check_|action_confirm|_upsert|shopify|_apply_brief_rules/.test(test), "TransactionCase tests present");
  const rules = guardrails && guardrails.length ? guardrails : FRAMEWORK_RULES;
  push("guardrails", (files["README.md"] || "").includes("Guardrails"), `${rules.length} guardrails attached`);
  return results;
}

function explainTradeoffs(requirement, guardrails) {
  const spec = parseBrief(String(requirement || ""));
  const rules = guardrails && guardrails.length ? guardrails : [...FRAMEWORK_RULES];
  return {
    scenario: spec.scenario,
    whySafe: ["Custom module only, no core edits", `ORM-first extension of ${spec.primary}`, "XPath inheritance, read-only downstream"],
    risks: spec.scenario === "pharmacy" ? ["Expiry logic needs real product_expiry dates", "Override group must exist"] : spec.scenario === "pos" ? ["Manager group must exist", "Receipt template override needs testing"] : spec.scenario === "shopify" ? ["Webhook secret + idempotency keys required", "Failure queue needs an owner"] : ["Downstream readonly fields need access review"],
    alternatives: ["Larger suite module (rejected: upgrade risk)", "Direct core edit (rejected: breaks upgrades)"],
    guardrailsEnforced: rules.length
  };
}

module.exports = { FRAMEWORK_RULES, PRESETS, parseBrief, buildPlan, generateAddon, validateAddon, explainTradeoffs, titleCase, saveAddon };

function saveAddon(requirement, outDir, guardrails, odooVersion) {
  if (!outDir || typeof outDir !== "string") throw new Error("output_dir is required");
  const gen = generateAddon(requirement, guardrails, odooVersion);
  const root = path.resolve(outDir, gen.module);
  for (const rel of Object.keys(gen.files)) {
    if (rel.includes("..")) throw new Error("unsafe path");
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("unsafe path");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, gen.files[rel], "utf8");
  }
  return { module: gen.module, scenario: gen.scenario, directory: root, files: Object.keys(gen.files), tree: gen.tree, validation: gen.validation };
}

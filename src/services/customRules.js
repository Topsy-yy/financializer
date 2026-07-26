// User-defined financial rules. These do NOT re-implement the risk engine —
// they evaluate NEW conditions the engine doesn't cover, and for conditions the
// engine already detects (duplicates) they reuse its output so alerts never double.

const RULE_TYPES = [
  { key: "expense_over",        label: "Expense above amount",        input: "amount",  hint: "Flags any transaction above the amount." },
  { key: "cash_below",          label: "Cash balance below amount",   input: "amount",  hint: "Flags when month-end cash is below the amount." },
  { key: "vendor_payment_over", label: "Vendor payment above amount", input: "amount",  hint: "Flags payments above the amount." },
  { key: "duplicate_payment",   label: "Duplicate payment",           input: "none",    hint: "Reuses the engine's duplicate detection (no double alerts)." },
  { key: "weekend_transaction", label: "Weekend transaction",         input: "none",    hint: "Flags transactions dated on a Saturday or Sunday." },
  { key: "director_expense",    label: "Director / owner expense",    input: "none",    hint: "Flags transactions matching owner/director keywords." },
  { key: "unknown_supplier",    label: "Unknown / one-off supplier",  input: "none",    hint: "Flags suppliers seen only once this period." },
  { key: "keyword",             label: "Transaction keyword",         input: "keyword", hint: "Flags transactions whose text contains the keyword." }
];

const ACTIONS = ["flag", "notify", "require_approval", "escalate", "ignore"];
const SEVERITIES = ["low", "medium", "high"];
const DEFAULT_OWNER_KEYWORDS = ["director", "owner", "personal", "withdrawal", "drawings"];
const MAX_FINDINGS_PER_RULE = 12;

const EXAMPLE_RULES = [
  { name: "Large expense",          description: "Any transaction over KES 200,000",     severity: "high",   condition: { type: "expense_over", amount: 200000 },        action: "require_approval" },
  { name: "Low cash balance",       description: "Cash balance below KES 500,000",        severity: "high",   condition: { type: "cash_below", amount: 500000 },          action: "escalate" },
  { name: "Big vendor payment",     description: "Vendor payment above KES 100,000",      severity: "medium", condition: { type: "vendor_payment_over", amount: 100000 }, action: "notify" },
  { name: "Duplicate payment watch",description: "Any duplicate payment",                 severity: "high",   condition: { type: "duplicate_payment" },                   action: "flag" },
  { name: "Weekend spend",          description: "Transactions dated on a weekend",       severity: "medium", condition: { type: "weekend_transaction" },                 action: "flag" },
  { name: "Director expenses",      description: "Owner/director-looking spend",          severity: "medium", condition: { type: "director_expense" },                    action: "notify" },
  { name: "Unknown supplier",       description: "One-off suppliers this month",          severity: "low",    condition: { type: "unknown_supplier" },                    action: "flag" },
  { name: "Sensitive keyword",      description: 'Transactions mentioning "cash"',        severity: "low",    condition: { type: "keyword", keyword: "cash" },            action: "flag" }
];

function money(n) {
  const v = Number(n);
  return "KES " + (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "0");
}

function validateRule(rule) {
  if (!rule || typeof rule !== "object") return { ok: false, error: "Rule is required." };
  const name = String(rule.name || "").trim();
  if (!name) return { ok: false, error: "Rule name is required." };
  const cond = rule.condition || {};
  const type = RULE_TYPES.find((t) => t.key === cond.type);
  if (!type) return { ok: false, error: "Unknown rule condition type." };
  const action = ACTIONS.includes(rule.action) ? rule.action : "flag";
  const severity = SEVERITIES.includes(rule.severity) ? rule.severity : "medium";
  const condition = { type: cond.type };
  if (type.input === "amount") {
    const amount = Number(cond.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "A positive amount is required for this rule." };
    condition.amount = amount;
  }
  if (type.input === "keyword") {
    const kw = String(cond.keyword || "").trim();
    if (!kw) return { ok: false, error: "A keyword is required for this rule." };
    condition.keyword = kw;
  }
  return {
    ok: true,
    rule: {
      name: name.slice(0, 80),
      description: String(rule.description || "").slice(0, 240),
      severity,
      condition,
      action,
      enabled: rule.enabled !== false
    }
  };
}

function txSignature(tx) {
  return (tx.date || "") + "|" + (tx.amount || "") + "|" + (tx.counterparty || tx.description || "");
}

// Evaluate ONE rule against the prepared context. Returns matchCount, sample
// descriptions, and anomaly findings (empty when action=ignore or when reusing
// an engine detection that is already surfaced).
function evaluateOne(rule, ctx) {
  const cond = rule.condition || {};
  const txns = ctx.transactions || [];
  const matches = [];
  let count = 0;

  const detailFor = (tx) => `${money(tx.amount)}${tx.counterparty ? " to " + tx.counterparty : ""}${tx.date ? " on " + tx.date : ""}`;

  switch (cond.type) {
    case "expense_over":
    case "vendor_payment_over":
      txns.forEach((tx) => { if (Number(tx.amount) > cond.amount) matches.push(tx); });
      break;
    case "cash_below":
      if (ctx.cashBalance != null && ctx.cashBalance < cond.amount) {
        count = 1;
        return {
          matchCount: 1,
          samples: [`Cash balance ${money(ctx.cashBalance)} is below ${money(cond.amount)}`],
          findings: rule.action === "ignore" ? [] : [finding(rule, `${rule.name}: cash balance ${money(ctx.cashBalance)} is below ${money(cond.amount)}`)]
        };
      }
      return { matchCount: 0, samples: [], findings: [] };
    case "duplicate_payment": {
      // Reuse the engine's duplicate detection — do NOT emit new anomalies
      // (the engine already surfaces duplicates), just report the count.
      const dups = (ctx.detections && ctx.detections.duplicates) || [];
      return {
        matchCount: dups.length,
        samples: dups.slice(0, 5).map((d) => `Duplicate around ${(d.duplicate || d.original || {}).date || "unknown date"}`),
        findings: [] // engine already alerts on these
      };
    }
    case "weekend_transaction":
      txns.forEach((tx) => {
        const day = new Date(tx.date).getUTCDay();
        if (day === 0 || day === 6) matches.push(tx);
      });
      break;
    case "director_expense": {
      const kws = (ctx.ownerKeywords && ctx.ownerKeywords.length ? ctx.ownerKeywords : DEFAULT_OWNER_KEYWORDS).map((k) => k.toLowerCase());
      txns.forEach((tx) => {
        const hay = ((tx.description || "") + " " + (tx.counterparty || "")).toLowerCase();
        if (kws.some((k) => k && hay.includes(k))) matches.push(tx);
      });
      break;
    }
    case "unknown_supplier":
      txns.forEach((tx) => {
        const cp = tx.counterparty || "";
        if (cp && ctx.vendorFreq[cp] === 1) matches.push(tx);
      });
      break;
    case "keyword": {
      const kw = String(cond.keyword || "").toLowerCase();
      txns.forEach((tx) => {
        const hay = ((tx.description || "") + " " + (tx.counterparty || "")).toLowerCase();
        if (kw && hay.includes(kw)) matches.push(tx);
      });
      break;
    }
    default:
      return { matchCount: 0, samples: [], findings: [] };
  }

  count = matches.length;
  const samples = matches.slice(0, 5).map(detailFor);
  let findings = [];
  if (rule.action !== "ignore") {
    findings = matches.slice(0, MAX_FINDINGS_PER_RULE).map((tx) => finding(rule, `${rule.name}: ${detailFor(tx)}`));
    if (matches.length > MAX_FINDINGS_PER_RULE) {
      findings.push(finding(rule, `${rule.name}: and ${matches.length - MAX_FINDINGS_PER_RULE} more`));
    }
  }
  return { matchCount: count, samples, findings };
}

function finding(rule, description) {
  let severity = rule.severity || "medium";
  let suffix = "";
  if (rule.action === "escalate") severity = "high";
  if (rule.action === "require_approval") suffix = " (approval required)";
  if (rule.action === "notify") suffix = " (notify)";
  return {
    type: "custom_rule",
    ruleId: rule.id || null,
    ruleName: rule.name,
    action: rule.action,
    severity,
    description: description + suffix
  };
}

// Shared evaluation context (transactions, cash, engine detections, vendor freq).
function buildCtx(monthlyData, analysis, opts) {
  opts = opts || {};
  const transactions = (monthlyData && monthlyData.transactions) || [];
  const cashBalance = monthlyData && monthlyData.statements && monthlyData.statements.balanceSheet
    ? Number(monthlyData.statements.balanceSheet.cashAndEquivalents)
    : null;
  const vendorFreq = {};
  transactions.forEach((tx) => { const cp = tx.counterparty || ""; if (cp) vendorFreq[cp] = (vendorFreq[cp] || 0) + 1; });
  return {
    transactions,
    cashBalance: Number.isFinite(cashBalance) ? cashBalance : null,
    detections: (analysis && analysis.detections) || {},
    ownerKeywords: opts.ownerKeywords || [],
    vendorFreq
  };
}

// Preview a single candidate rule (used before saving). Returns match count + samples.
function previewRule(rule, monthlyData, analysis, opts) {
  const v = validateRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  const res = evaluateOne(Object.assign({ id: "preview" }, v.rule), buildCtx(monthlyData, analysis, opts));
  return { ok: true, matchCount: res.matchCount, samples: res.samples };
}

// Evaluate all enabled rules. Returns merged (deduped) findings + per-rule executions.
function evaluateCustomRules(rules, monthlyData, analysis, opts) {
  opts = opts || {};
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.enabled !== false) : [];
  const ctx = buildCtx(monthlyData, analysis, opts);

  const findings = [];
  const executions = [];
  const seen = new Set();
  list.forEach((rule) => {
    const res = evaluateOne(rule, ctx);
    executions.push({ ruleId: rule.id || null, ruleName: rule.name, action: rule.action, severity: rule.severity, matchCount: res.matchCount });
    res.findings.forEach((f) => {
      if (seen.has(f.description)) return; // no duplicate alerts
      seen.add(f.description);
      findings.push(f);
    });
  });

  return { findings, executions };
}

module.exports = {
  RULE_TYPES,
  ACTIONS,
  SEVERITIES,
  EXAMPLE_RULES,
  validateRule,
  evaluateCustomRules,
  evaluateOne,
  previewRule
};

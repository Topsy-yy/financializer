// User-defined financial rules.
//
// These do NOT re-implement the engine. They evaluate conditions the engine does
// not cover, and for a condition the engine already detects (duplicates) they
// reuse its output so a user never gets two alerts for one fact.
//
// JOB 7 CHANGES — custom rules now use exactly the same infrastructure as
// built-in rules. Previously they emitted:
//
//     { type: "custom_rule", ruleId, ruleName, action, severity, description }
//
// a bare object with no stable id, no version, no evidence and no calculation.
// It could not be persisted as a Finding, traced to a source record, or
// explained. Worse, it entered `context.anomalies.items` alongside real
// findings, so a user rule that matched 12 transactions added 12 items of
// anomaly pressure to the deterministic health score — a user could move their
// own score by writing a rule.
//
// Now:
//   * every match produces a real Finding with evidence citing the record;
//   * the finding records ruleId (`custom:<id>`) and ruleVersion (the version of
//     the RULE RECORD the user authored, so editing a rule is a new version);
//   * severity comes from the registry's vocabulary, not free text;
//   * confidence is CERTAIN — the condition either matched or it did not — with
//     a basis that says the engine is certain the condition matched, not that
//     the condition is a good one;
//   * findings are marked `authorityScope: "tenant"` so risk aggregation can
//     exclude them from the deterministic score.
//
// This module lives under domain/rules because it IS rule evaluation. It stays
// pure: no HTTP, no database, no AI.

const { createFinding, createEvidence } = require("../model/finding");
const { readCashPosition } = require("../model/cashPosition");
const { getRule, resolveRule, SEVERITY } = require("./registry");
const { num, fmt, recordIdOf } = require("../calculators/shared");

/**
 * The condition types a user may build a rule from.
 * `engineBacked` types reuse a built-in rule's output instead of re-detecting.
 */
const RULE_TYPES = [
  { key: "expense_over", label: "Expense above amount", input: "amount",
    hint: "Flags any transaction above the amount." },
  { key: "cash_below", label: "Cash balance below amount", input: "amount",
    hint: "Flags when month-end cash is below the amount." },
  { key: "vendor_payment_over", label: "Vendor payment above amount", input: "amount",
    hint: "Flags payments above the amount." },
  { key: "duplicate_payment", label: "Duplicate payment", input: "none", engineBacked: true,
    hint: "Reuses the engine's duplicate detection (no double alerts)." },
  { key: "weekend_transaction", label: "Weekend transaction", input: "none",
    hint: "Flags transactions dated on a Saturday or Sunday." },
  { key: "director_expense", label: "Director / owner expense", input: "none",
    hint: "Flags transactions matching owner/director keywords." },
  { key: "unknown_supplier", label: "Unknown / one-off supplier", input: "none",
    hint: "Flags suppliers seen only once this period." },
  { key: "keyword", label: "Transaction keyword", input: "keyword",
    hint: "Flags transactions whose text contains the keyword." }
];

const ACTIONS = ["flag", "notify", "require_approval", "escalate", "ignore"];
/** The severity vocabulary is the REGISTRY's, not a second list. */
const SEVERITIES = Object.values(SEVERITY);

const EXAMPLE_RULES = [
  { name: "Large expense", description: "Any transaction over KES 200,000", severity: "high",
    condition: { type: "expense_over", amount: 200000 }, action: "require_approval" },
  { name: "Low cash balance", description: "Cash balance below KES 500,000", severity: "high",
    condition: { type: "cash_below", amount: 500000 }, action: "escalate" },
  { name: "Big vendor payment", description: "Vendor payment above KES 100,000", severity: "medium",
    condition: { type: "vendor_payment_over", amount: 100000 }, action: "notify" },
  { name: "Duplicate payment watch", description: "Any duplicate payment", severity: "high",
    condition: { type: "duplicate_payment" }, action: "flag" },
  { name: "Weekend spend", description: "Transactions dated on a weekend", severity: "medium",
    condition: { type: "weekend_transaction" }, action: "flag" },
  { name: "Director expenses", description: "Owner/director-looking spend", severity: "medium",
    condition: { type: "director_expense" }, action: "notify" },
  { name: "Unknown supplier", description: "One-off suppliers this month", severity: "low",
    condition: { type: "unknown_supplier" }, action: "flag" },
  { name: "Sensitive keyword", description: 'Transactions mentioning "cash"', severity: "low",
    condition: { type: "keyword", keyword: "cash" }, action: "flag" }
];

/**
 * Format an amount WITH its currency.
 * Previously hardcoded "KES " onto every number regardless of the record.
 */
function money(amount, currency) {
  const value = fmt(amount);
  return currency ? `${currency} ${value}` : value;
}

function validateRule(rule) {
  if (!rule || typeof rule !== "object") return { ok: false, error: "Rule is required." };
  const name = String(rule.name || "").trim();
  if (!name) return { ok: false, error: "Rule name is required." };
  const cond = rule.condition || {};
  const type = RULE_TYPES.find((t) => t.key === cond.type);
  if (!type) return { ok: false, error: "Unknown rule condition type." };
  const action = ACTIONS.includes(rule.action) ? rule.action : "flag";
  const severity = SEVERITIES.includes(rule.severity) ? rule.severity : SEVERITY.MEDIUM;

  const condition = { type: cond.type };
  if (type.input === "amount") {
    const amount = Number(cond.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "A positive amount is required for this rule." };
    }
    condition.amount = amount;
    // A threshold without a currency is ambiguous. It is recorded, not guessed:
    // when absent the rule is compared against raw amounts and the finding says so.
    if (cond.currency) condition.currency = String(cond.currency).toUpperCase().slice(0, 3);
  }
  if (type.input === "keyword") {
    const keyword = String(cond.keyword || "").trim();
    if (!keyword) return { ok: false, error: "A keyword is required for this rule." };
    condition.keyword = keyword;
  }

  return {
    ok: true,
    rule: {
      name: name.slice(0, 80),
      description: String(rule.description || "").slice(0, 240),
      severity,
      condition,
      action,
      enabled: rule.enabled !== false,
      // The version of THIS rule record. Editing a rule should produce a new
      // version so historical findings stay attributable to what actually ran.
      version: String(rule.version || "1"),
      id: rule.id || null
    }
  };
}

/** Stable rule id in the registry's namespace: `custom:<user rule id>`. */
function customRuleId(rule) {
  return `custom:${rule.id || slug(rule.name)}`;
}

function slug(name) {
  return String(name || "rule").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

/**
 * Build a Finding for one custom-rule match.
 *
 * Goes through createFinding with the registry's `custom_rule` entry supplying
 * the category and confidence basis, so a custom finding is structurally
 * indistinguishable from a built-in one — except that it declares
 * `authorityScope: "tenant"`, which is what keeps it out of the deterministic
 * score.
 */
function customFinding(rule, ctx, { tx, index, description, observed, threshold, metric, calculation }) {
  const resolved = resolveRule("custom_rule", {});
  // The AUTHOR chooses severity; `escalate` promotes it, mirroring the old
  // behaviour but through the registry's vocabulary.
  const severity = rule.action === "escalate" ? SEVERITY.HIGH : rule.severity;
  const suffix = rule.action === "require_approval" ? " (approval required)"
    : rule.action === "notify" ? " (notify)" : "";

  return createFinding({
    tenantId: ctx.tenantId || null,
    period: ctx.period || null,
    ruleId: customRuleId(rule),
    // The user's rule version, NOT the registry entry's — the registry entry
    // versions the evaluation machinery, the rule record versions the condition.
    ruleVersion: rule.version || "1",
    category: resolved.category,
    severity,
    severityBasis: resolved.severityBasis,
    severityReason: `Severity chosen by the rule's author${rule.action === "escalate" ? ", raised to high by the escalate action" : ""}.`,
    confidence: resolved.confidence,
    confidenceBasis: resolved.confidenceBasis,
    confidenceReason: resolved.confidenceReason,
    title: rule.name,
    description: description + suffix,
    metric: metric || null,
    observedValue: observed == null ? null : observed,
    threshold: threshold == null ? null : threshold,
    currency: (tx && tx.currency) || (rule.condition && rule.condition.currency) || null,
    calculation,
    evidence: tx
      ? [createEvidence({
        label: "Matching transaction",
        sourceSystem: tx.sourceSystem || null,
        sourceRecordId: recordIdOf(tx, index),
        recordType: tx.recordType || "transaction",
        relationship: "matched",
        fields: {
          date: tx.date || null,
          amount: num(tx.amount),
          currency: tx.currency || null,
          counterparty: tx.counterparty || null,
          description: tx.description || null
        }
      })]
      : [createEvidence({
        label: "Period cash position",
        recordType: "statement",
        relationship: "computed_from",
        fields: { cash_on_hand: ctx.cashBalance, currency: ctx.currency || null }
      })],
    // THE GUARD: tenant-authored, so risk aggregation excludes it.
    authorityScope: "tenant",
    discriminator: `${customRuleId(rule)}:${index == null ? "period" : index}`
  });
}

/** Evaluate ONE rule against the prepared context. */
function evaluateOne(rule, ctx) {
  const cond = rule.condition || {};
  const txns = ctx.transactions || [];
  const registryRule = getRule("custom_rule");
  const max = registryRule.params.maxFindingsPerRule;
  const matches = [];

  const detail = (tx) =>
    `${money(tx.amount, tx.currency)}${tx.counterparty ? " to " + tx.counterparty : ""}${tx.date ? " on " + tx.date : ""}`;

  switch (cond.type) {
    case "expense_over":
    case "vendor_payment_over":
      txns.forEach((tx, index) => {
        // Only compare against a threshold in the SAME currency. A rule written
        // as "over 200,000" against a USD record would otherwise fire on an
        // amount a fiftieth of what the author meant.
        if (cond.currency && tx.currency && String(tx.currency).toUpperCase() !== cond.currency) return;
        if (num(tx.amount) > cond.amount) matches.push({ tx, index });
      });
      break;

    case "cash_below": {
      /* NOT EVALUATED is not the same as NO MATCH.
         Without an observed cash balance this rule cannot be judged at all.
         Returning a plain zero-match would tell the user their rule ran and
         found nothing, when in fact it never ran -- and the previous code did
         exactly that after silently reading a derived estimate. The outcome is
         reported so the execution history can say why. */
      if (!ctx.cashPosition || !ctx.cashPosition.available) {
        return {
          matchCount: 0, samples: [], findings: [],
          evaluated: false,
          skippedReason: ctx.cashPosition
            ? ctx.cashPosition.unavailableReason
            : "no_data",
          skippedDetail: ctx.cashPosition
            && ctx.cashPosition.basis === "derived_from_net_income"
            ? "No cash balance was supplied. An estimate was derived from net "
              + "income, which is not a cash position, so this rule was not evaluated."
            : "No cash balance is available for this period, so this rule was not evaluated."
        };
      }
      if (ctx.cashBalance >= cond.amount) {
        return { matchCount: 0, samples: [], findings: [] };
      }
      const description =
        `${rule.name}: cash balance ${money(ctx.cashBalance, ctx.currency)} is below ${money(cond.amount, cond.currency || ctx.currency)}`;
      return {
        matchCount: 1,
        samples: [description],
        findings: rule.action === "ignore" ? [] : [customFinding(rule, ctx, {
          tx: null, index: null, description,
          observed: ctx.cashBalance, threshold: cond.amount, metric: "cash_on_hand",
          calculation: `cash on hand ${ctx.cashBalance} < rule threshold ${cond.amount}`
        })]
      };
    }

    case "duplicate_payment": {
      // Reuse the engine's detection. Emitting our own would double-alert AND
      // add a second, differently-versioned duplicate rule to the system.
      const dups = (ctx.detections && ctx.detections.duplicates) || [];
      return {
        matchCount: dups.length,
        samples: dups.slice(0, 5).map((d) =>
          `Duplicate around ${(d.duplicate || d.original || {}).date || "unknown date"}`),
        findings: [] // the engine already surfaced these, with its own rule id
      };
    }

    case "weekend_transaction":
      txns.forEach((tx, index) => {
        const day = new Date(tx.date).getUTCDay();
        if (day === 0 || day === 6) matches.push({ tx, index });
      });
      break;

    case "director_expense": {
      // ONE keyword list, from the registry — shared with the engine's
      // mixed_personal_business rule. This module previously had a second,
      // different list, so the same transaction could match a user rule and
      // not the engine rule.
      const keywords = (ctx.ownerKeywords && ctx.ownerKeywords.length
        ? ctx.ownerKeywords
        : getRule("mixed_personal_business").params.keywords).map((k) => String(k).toLowerCase());
      txns.forEach((tx, index) => {
        const haystack = `${tx.description || ""} ${tx.counterparty || ""}`.toLowerCase();
        if (keywords.some((k) => k && haystack.includes(k))) matches.push({ tx, index });
      });
      break;
    }

    case "unknown_supplier":
      txns.forEach((tx, index) => {
        const cp = tx.counterparty || "";
        if (cp && ctx.vendorFreq[cp] === 1) matches.push({ tx, index });
      });
      break;

    case "keyword": {
      const keyword = String(cond.keyword || "").toLowerCase();
      txns.forEach((tx, index) => {
        const haystack = `${tx.description || ""} ${tx.counterparty || ""}`.toLowerCase();
        if (keyword && haystack.includes(keyword)) matches.push({ tx, index });
      });
      break;
    }

    default:
      return { matchCount: 0, samples: [], findings: [] };
  }

  const samples = matches.slice(0, 5).map(({ tx }) => detail(tx));
  let findings = [];
  if (rule.action !== "ignore") {
    findings = matches.slice(0, max).map(({ tx, index }) => customFinding(rule, ctx, {
      tx,
      index,
      description: `${rule.name}: ${detail(tx)}`,
      observed: cond.amount != null ? num(tx.amount) : null,
      threshold: cond.amount != null ? cond.amount : null,
      metric: cond.amount != null ? "amount" : null,
      calculation: cond.amount != null
        ? `amount ${num(tx.amount)} > rule threshold ${cond.amount}`
        : `Transaction matched the "${cond.type}" condition.`
    }));
  }

  return {
    matchCount: matches.length,
    samples,
    findings,
    // Truncation is REPORTED, never silent — a rule matching 200 records must
    // not look like a rule matching 12.
    truncated: matches.length > max ? matches.length - max : 0
  };
}

/** Shared evaluation context. */
function buildCtx(monthlyData, analysis, opts) {
  opts = opts || {};
  const transactions = (monthlyData && monthlyData.transactions) || [];
  const balanceSheet = monthlyData && monthlyData.statements && monthlyData.statements.balanceSheet;
  /* THE BYPASS THIS CLOSES. This read `Number(balanceSheet.cashAndEquivalents)`
     directly, ignoring provenance entirely. When an upload supplies no cash
     balance, ingestion derives one as `Math.max(0, netIncome)` -- which on any
     loss-making month is exactly 0. A user-authored `cash_below` rule would
     therefore fire "your cash balance is below X" against a figure NOBODY
     SUPPLIED, and emit it as a finding with the derived number as evidence.

     Read through the one authoritative accessor now, so an estimate cannot be
     mistaken for a measurement here or anywhere else. */
  const cashPosition = readCashPosition(balanceSheet);
  const vendorFreq = {};
  transactions.forEach((tx) => {
    const cp = tx.counterparty || "";
    if (cp) vendorFreq[cp] = (vendorFreq[cp] || 0) + 1;
  });

  return {
    transactions,
    // AUTHORITATIVE cash only: null unless the source actually told us.
    cashBalance: cashPosition.value,
    // The full classification, so a rule can explain WHY it could not evaluate.
    cashPosition,
    currency: opts.currency || null,
    detections: (analysis && analysis.detections) || {},
    ownerKeywords: opts.ownerKeywords || [],
    tenantId: opts.tenantId || null,
    period: opts.period || (monthlyData && monthlyData.period) || null,
    vendorFreq
  };
}

/** Preview a candidate rule before saving. */
function previewRule(rule, monthlyData, analysis, opts) {
  const v = validateRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  const res = evaluateOne(Object.assign({ id: "preview" }, v.rule), buildCtx(monthlyData, analysis, opts));
  return { ok: true, matchCount: res.matchCount, samples: res.samples };
}

/** Evaluate all enabled rules. Returns real Findings plus per-rule executions. */
function evaluateCustomRules(rules, monthlyData, analysis, opts) {
  opts = opts || {};
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.enabled !== false) : [];
  const ctx = buildCtx(monthlyData, analysis, opts);

  const findings = [];
  const executions = [];
  const seen = new Set();

  list.forEach((rule) => {
    const res = evaluateOne(rule, ctx);
    executions.push({
      ruleId: customRuleId(rule),
      ruleVersion: rule.version || "1",
      ruleName: rule.name,
      action: rule.action,
      severity: rule.severity,
      matchCount: res.matchCount,
      truncated: res.truncated || 0,
      /* Whether the rule could be JUDGED. `evaluated: false` with a reason is
         how a user learns their rule was skipped for want of an authoritative
         input, rather than believing it ran and found nothing. */
      evaluated: res.evaluated !== false,
      skippedReason: res.skippedReason || null,
      skippedDetail: res.skippedDetail || null
    });
    res.findings.forEach((f) => {
      // Dedupe on the STABLE finding id, not the description text.
      if (seen.has(f.findingId)) return;
      seen.add(f.findingId);
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
  previewRule,
  customRuleId
};

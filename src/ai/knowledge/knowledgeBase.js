// THE KNOWLEDGE BASE — what the AI may be told ABOUT finance, as opposed to
// what it is told about THIS BUSINESS.
//
// THE DIVIDING LINE, which the whole subsystem depends on:
//
//   KNOWLEDGE (this module)   general, tenant-independent, explanatory.
//                             "What is cash runway?" "Why does concentration
//                             matter?" "How does the duplicate rule work?"
//
//   FINANCIAL DATA (context/) this tenant's computed Findings, Metrics,
//                             RiskScore and records. Comes from PostgreSQL and
//                             the deterministic engine, NEVER from here.
//
// Authoritative computed figures are never copied into knowledge. A knowledge
// document may say "runway is cash on hand divided by monthly burn"; it may not
// say "your runway is 4 months". The first is stable and reusable; the second
// would be a second, staler copy of a number the engine owns.
//
// KNOWLEDGE NEVER OVERRIDES THE REGISTRY. Rule documents here are GENERATED from
// src/domain/rules/registry.js at load time, so a rule explanation cannot drift
// from the rule. That is the failure this replaces: the eleven skill.md files
// were concatenated into the system prompt with thresholds that no longer
// matched the engine.

const fs = require("fs");
const path = require("path");
const registry = require("../../domain/rules/registry");
const methodology = require("../../domain/rules/methodology");

const SKILLS_DIR = path.resolve(__dirname, "..", "..", "..", "skills");

/** What a document is for — used to weight retrieval and to explain provenance. */
const DOC_KIND = Object.freeze({
  RULE: "rule",                 // generated from the registry
  METHODOLOGY: "methodology",   // generated from the registry
  CONCEPT: "concept",           // general financial-control education
  PRODUCT: "product"            // how this product behaves (from skill docs)
});

/**
 * A knowledge document, split into retrievable chunks.
 *
 * Chunks are paragraph-sized because retrieval returns chunks, not documents:
 * sending a whole 150-line skill file to answer "what is a duplicate payment?"
 * is what the old prompt did, and it crowded out the tenant's actual data.
 */
function makeDocument({ id, title, kind, source, text, tags = [] }) {
  const chunks = chunkText(text).map((body, i) => Object.freeze({
    chunkId: `${id}#${i}`,
    docId: id,
    title,
    kind,
    source,
    tags: Object.freeze([...tags]),
    text: body
  }));
  return Object.freeze({ id, title, kind, source, tags: Object.freeze([...tags]), chunks });
}

/** Split on blank lines, then merge short fragments so a chunk carries context. */
function chunkText(text, targetChars = 700) {
  const paragraphs = String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  paragraphs.forEach((p) => {
    if (current && (current.length + p.length) > targetChars) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

// ─────────────────────────────────────────────────────────────────
// Generated knowledge: rules and methodology, straight from the registry.
// ─────────────────────────────────────────────────────────────────

/** One document per rule, so "why was this flagged?" retrieves that rule alone. */
function ruleDocuments() {
  return registry.allRules().map((rule) => {
    const sev = rule.severity.fixed
      ? `Always ${rule.severity.fixed} severity, because: ${rule.severity.reason}`
      : rule.severity.bands.map((b) => {
        const cond = b.above != null ? `above ${b.above}`
          : b.below != null ? `below ${b.below}` : "otherwise";
        return `${cond} => ${b.severity} (${b.reason})`;
      }).join("; ");

    const text = [
      `Rule: ${rule.title} (id ${rule.id}, version ${rule.version}).`,
      rule.summary,
      "",
      `Why this rule exists. ${rule.rationale}`,
      "",
      `How it is calculated. ${rule.methodology}`,
      `Parameters actually used: ${JSON.stringify(rule.params)}.`,
      "",
      `Severity. ${sev}`,
      `Confidence. Base ${rule.confidence.base} (${rule.confidence.basis}). ${rule.confidence.rationale}`,
      "",
      `Evidence required. ${rule.evidence.mustCiteRecords
        ? `A finding must cite at least ${rule.evidence.minRecords} source record(s).`
        : "Derived from computed values rather than individual records."}`,
      `Data required to run: ${rule.applicability.requires.join(", ") || "none"}.`
    ].join("\n");

    return makeDocument({
      id: `rule:${rule.id}`,
      title: rule.title,
      kind: DOC_KIND.RULE,
      source: "src/domain/rules/registry.js",
      text,
      tags: [rule.id, rule.category, "rule", ...rule.id.split("_")]
    });
  });
}

/** The scoring, coverage, materiality and currency methodology. */
function methodologyDocuments() {
  const m = methodology.describeMethodology();
  const docs = [];

  docs.push(makeDocument({
    id: "methodology:risk-score",
    title: "How the financial health score is calculated",
    kind: DOC_KIND.METHODOLOGY,
    source: "src/domain/rules/registry.js",
    text: [
      "The overall financial health score is a weighted average of five components, "
      + `scored 0-100 (scoring methodology version ${m.scoring.version}).`,
      Object.entries(m.scoring.weights).map(([k, v]) => `- ${k}: weight ${v}`).join("\n"),
      "",
      "Score bands: " + m.scoring.categories
        .map((c) => `${c.atOrAbove == null ? "below all bands" : `${c.atOrAbove}+`} = ${c.label}`)
        .join(", ") + ".",
      "",
      m.scoring.unmeasuredComponents,
      "",
      "The score is produced by the deterministic engine. It is never estimated, "
      + "adjusted or recomputed by an AI model."
    ].join("\n"),
    tags: ["score", "health", "risk", "weights", "methodology", "rating", "grade"]
  }));

  docs.push(makeDocument({
    id: "methodology:evidence-coverage",
    title: "When a risk score is withheld for insufficient evidence",
    kind: DOC_KIND.METHODOLOGY,
    source: "src/domain/rules/evidenceCoverage.js",
    text: [
      `Principle: ${m.evidenceCoverage.principle}`,
      "",
      "A component is only counted as measured when the data its rules require was "
      + "actually present. Unmeasured components are excluded from the weighted average "
      + "and the remaining weights are renormalised; they are never defaulted to a value.",
      "",
      `A score is published only when at least ${Math.round(m.evidenceCoverage.minimumWeightCovered * 100)}% `
      + "of the model's weight was measured. Below that the result is reported as "
      + "insufficient evidence with a reason, never as a low score. "
      + "\"We cannot tell\" and \"this is bad\" are different answers.",
      "",
      "This means a business with very little data will see an Unknown score rather "
      + "than a good one. That is deliberate: absence of data must never look like health."
    ].join("\n"),
    tags: ["insufficient", "evidence", "coverage", "unknown", "unavailable", "missing", "data"]
  }));

  docs.push(makeDocument({
    id: "methodology:materiality",
    title: "How the system decides an amount is significant",
    kind: DOC_KIND.METHODOLOGY,
    source: "src/domain/rules/materiality.js",
    text: [
      m.materiality.method,
      "",
      "Absolute floors by currency: " + Object.entries(m.materiality.absoluteFloors)
        .map(([code, f]) => `${code} ${f.significant}`).join(", ") + ".",
      "",
      `When the source does not state a currency, ${m.materiality.defaultCurrency} is assumed, `
      + "and any finding produced under that assumption records it.",
      "",
      "Materiality is resolved once per period, per currency, and every finding that "
      + "used it records the threshold and the calculation behind it."
    ].join("\n"),
    tags: ["materiality", "significant", "threshold", "large", "small", "round number", "currency"]
  }));

  docs.push(makeDocument({
    id: "methodology:currency",
    title: "How multiple currencies are handled",
    kind: DOC_KIND.METHODOLOGY,
    source: "src/domain/rules/currency.js",
    text: [
      m.currency.principle,
      "",
      "In practice: when a period's records span more than one currency, totals and "
      + "concentration percentages for that period are reported as unavailable, with a "
      + "per-currency breakdown alongside. The system does not convert, because it has "
      + "no exchange-rate source and an invented rate would produce an invented figure.",
      "",
      "Amounts in different declared currencies are also never treated as equal, so two "
      + "payments of the same number in different currencies are not duplicates."
    ].join("\n"),
    tags: ["currency", "fx", "exchange", "mixed", "usd", "kes", "eur", "conversion"]
  }));

  docs.push(makeDocument({
    id: "methodology:severity-confidence",
    title: "What severity and confidence mean on a finding",
    kind: DOC_KIND.METHODOLOGY,
    source: "src/domain/rules/severity.js",
    text: [
      m.severityScale.note,
      "",
      m.confidenceScale.note,
      "",
      "Confidence levels: " + Object.entries(m.confidenceScale.levels)
        .map(([k, v]) => `${k} = ${v}`).join(", ") + ".",
      "",
      "A finding can be high severity and low confidence at once: a round-number "
      + "payment matters if it is real, but most round payments are legitimate. The two "
      + "must be read together, and neither is a statement about an AI model."
    ].join("\n"),
    tags: ["severity", "confidence", "high", "medium", "low", "certain", "probable", "means"]
  }));

  return docs;
}

// ─────────────────────────────────────────────────────────────────
// Concept knowledge: general financial-control education.
// ─────────────────────────────────────────────────────────────────

const CONCEPTS = [
  {
    id: "concept:cash-runway",
    title: "Cash runway",
    tags: ["runway", "burn", "cash", "months", "survive", "out of money"],
    text:
      "Cash runway is how long a business can keep operating at its current rate of "
      + "spending before it runs out of cash. It is cash on hand divided by monthly net "
      + "burn, where burn is the amount by which outflows exceed inflows.\n\n"
      + "Runway is only meaningful when both inputs are known. A business that is not "
      + "burning cash has no runway limit to report — that is different from a business "
      + "whose runway could not be calculated.\n\n"
      + "For an SME, runway is the number that decides how urgent everything else is. "
      + "A concentration risk with two years of runway is a planning problem; the same "
      + "risk with two months of runway is an emergency."
  },
  {
    id: "concept:concentration-risk",
    title: "Customer and vendor concentration",
    tags: ["concentration", "vendor", "supplier", "customer", "dependency", "diversify"],
    text:
      "Concentration risk is the exposure created by depending on a small number of "
      + "counterparties. Customer concentration means a large share of revenue comes "
      + "from one client; vendor concentration means a large share of spend goes to one "
      + "supplier.\n\n"
      + "Customer concentration is usually the more dangerous of the two: losing a "
      + "customer removes income immediately, while a supplier can often be replaced. "
      + "Neither is a fault — many healthy businesses are concentrated — but both are "
      + "exposures that should be known and deliberately accepted rather than "
      + "discovered during a disruption.\n\n"
      + "Concentration can only be measured over amounts that share a currency and can "
      + "be attributed to a named counterparty. Unattributed spend is a bookkeeping "
      + "gap, not a diversified supplier base."
  },
  {
    id: "concept:duplicate-payments",
    title: "Duplicate payments",
    tags: ["duplicate", "paid twice", "double", "payment", "recover"],
    text:
      "A duplicate payment is the same obligation settled more than once. It is one of "
      + "the most recoverable errors in a small business: the money usually still exists "
      + "at the supplier and can be reclaimed or credited.\n\n"
      + "Duplicates are identified by records that agree on date, amount, counterparty "
      + "and currency. Agreement is not proof — instalments, recurring same-day charges "
      + "and split invoices legitimately look identical — so a duplicate finding is a "
      + "prompt to check, not an accusation.\n\n"
      + "The practical response is to match both records against the underlying invoice "
      + "or statement before contacting the supplier."
  },
  {
    id: "concept:reconciliation",
    title: "Bank reconciliation",
    tags: ["reconcile", "reconciliation", "bank", "statement", "match", "books"],
    text:
      "Reconciliation is the process of matching the transactions in the accounting "
      + "records against the bank's own statement, so that both agree.\n\n"
      + "It is the control that makes every other financial number trustworthy. Until an "
      + "account is reconciled, a reported balance is a claim rather than a verified "
      + "fact, and errors — missing transactions, duplicates, incorrect amounts — can "
      + "sit undetected.\n\n"
      + "An unreconciled account does not mean something is wrong. It means nothing can "
      + "be confirmed, which is why it is reported as a control weakness rather than as "
      + "a business risk."
  },
  {
    id: "concept:data-quality-vs-risk",
    title: "Data quality is not financial risk",
    tags: ["data quality", "incomplete", "missing", "receipts", "records", "bookkeeping"],
    text:
      "Findings fall into two groups that must not be mixed. Business risk describes "
      + "the BUSINESS: short runway, concentrated revenue, overdue invoices. Data "
      + "quality describes the BOOKS: missing fields, unreconciled accounts, absent "
      + "receipts.\n\n"
      + "A business with excellent finances and poor bookkeeping is not a risky "
      + "business; it is a well-run business with an administrative problem. Scoring "
      + "them together would punish it for the wrong thing — and would reward a "
      + "business that supplies less data, since fewer records mean fewer detectable "
      + "gaps.\n\n"
      + "The two are therefore reported separately: a business risk score, and a data "
      + "quality grade."
  },
  {
    id: "concept:working-capital",
    title: "Receivables, payables and working capital",
    tags: ["receivable", "payable", "invoice", "overdue", "collections", "working capital"],
    text:
      "Receivables are money owed to the business by customers; payables are money the "
      + "business owes suppliers. The gap between them, alongside cash, is working "
      + "capital — the money available to run day-to-day operations.\n\n"
      + "An overdue receivable is the most direct near-term cash risk an SME faces: "
      + "revenue has been earned and recorded, but the cash has not arrived, so the "
      + "profit-and-loss statement looks healthier than the bank account.\n\n"
      + "Chasing collections is usually faster and cheaper than raising finance, which "
      + "is why overdue receivables are flagged as high severity when they are past due "
      + "AND still have an outstanding balance."
  },
  {
    id: "concept:mixed-personal-business",
    title: "Mixing personal and business funds",
    tags: ["personal", "director", "owner", "drawings", "mixed", "separate"],
    text:
      "Mixing personal and business money means paying personal expenses from a "
      + "business account, or the reverse. It is common in owner-managed businesses and "
      + "is often not dishonest — but it is a governance and tax problem regardless of "
      + "intent.\n\n"
      + "It makes the accounts an unreliable picture of the business, complicates tax "
      + "treatment, and in some structures weakens the legal separation between the "
      + "owner and the company.\n\n"
      + "Detection is by keyword matching on descriptions, which is crude: a supplier "
      + "genuinely named 'Director Supplies Ltd' will match. Findings of this kind "
      + "raise a question to check, never a conclusion."
  }
];

// ─────────────────────────────────────────────────────────────────
// Product knowledge: from the skill documents, WITHOUT methodology.
// ─────────────────────────────────────────────────────────────────

/**
 * Load the skill documents as PRODUCT knowledge.
 *
 * These describe positioning, tone and what each part of the product does. Their
 * financial methodology was removed in JOB 7 and replaced with a pointer to the
 * registry — and they are no longer concatenated wholesale into every prompt.
 * They are now retrievable chunks like any other knowledge, competing on
 * relevance rather than being unconditionally present.
 */
function skillDocuments() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(SKILLS_DIR, entry.name, "skill.md");
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, "utf-8");
      return makeDocument({
        id: `skill:${entry.name}`,
        title: entry.name.replace(/-/g, " "),
        kind: DOC_KIND.PRODUCT,
        source: `skills/${entry.name}/skill.md`,
        text: raw,
        tags: [entry.name, ...entry.name.split("-")]
      });
    })
    .filter(Boolean);
}

let cache = null;

/** Build (once) and return every knowledge document. */
function loadKnowledge({ reload = false } = {}) {
  if (cache && !reload) return cache;
  const docs = [].concat(
    ruleDocuments(),
    methodologyDocuments(),
    CONCEPTS.map((c) => makeDocument({
      id: c.id, title: c.title, kind: DOC_KIND.CONCEPT,
      source: "src/ai/knowledge/knowledgeBase.js", text: c.text, tags: c.tags
    })),
    skillDocuments()
  );
  cache = Object.freeze({
    documents: Object.freeze(docs),
    chunks: Object.freeze(docs.flatMap((d) => d.chunks)),
    // Bumped whenever the registry changes, since rule docs are generated from it.
    version: `${registry.ENGINE_VERSION}+kb1`
  });
  return cache;
}

module.exports = { DOC_KIND, loadKnowledge, makeDocument, chunkText };

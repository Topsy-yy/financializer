// SOURCE DOCUMENTS (PDF) -> a normalized monthly dataset.
//
// Users do not keep their books as CSV. They keep a folder of invoices, bills,
// payment receipts and bank slips. This reads that folder.
//
// THE RULE THIS MODULE IS BUILT AROUND: never infer a financial figure.
//
// A PDF importer that guesses which number on a page is the total would be the
// most dangerous thing in this codebase — it would put fabricated amounts into
// an analysis that the user is told is authoritative. So every document must
// state its own fields explicitly. A document that does not is REJECTED, by
// name, with a reason, and contributes nothing. A rejected file is reported to
// the user; it is never silently dropped and never approximated.
//
// TRANSACTIONS vs EVIDENCE. An invoice and its bank slip describe the SAME
// money. Importing both would double every figure. So:
//
//   INVOICE, VENDOR BILL          the transaction
//   PAYMENT RECEIPT, BANK SLIP    evidence that it was settled
//
// Receipts attach to the document they reference and set `hasReceipt`. That is
// how a real folder works, and it is what lets the `missing_receipt` rule mean
// something: a bill with no receipt beside it is a payment with no proof.

const crypto = require("crypto");
const { extractPdfText } = require("./pdfTextExtract");

/* The labels a document may carry. Extracted PDF text arrives as one run
   without newlines, so a field is bounded by the NEXT label rather than by a
   line ending — anchoring on `\n` would swallow the rest of the page. */
const LABELS = [
  "Document Type", "Document No", "Issue Date", "Date", "Counterparty",
  "Description", "Currency", "Direction", "Total", "Amount (KES)", "Amount",
  "Payment Method", "Reference", "Receipt Attached", "Due Date", "Generated"
];

const TRANSACTION_DOCS = ["INVOICE", "VENDOR BILL", "BILL", "CREDIT NOTE"];
const EVIDENCE_DOCS = ["PAYMENT RECEIPT", "BANK DEPOSIT SLIP", "RECEIPT", "BANK SLIP"];

function fieldPattern(label) {
  const others = LABELS.filter((l) => l !== label)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc}\\s*:\\s*(.*?)\\s*(?=(?:${others})\\s*:|$)`, "i");
}

const PATTERNS = new Map(LABELS.map((l) => [l, fieldPattern(l)]));

function field(text, label) {
  const m = PATTERNS.get(label).exec(text);
  if (!m) return null;
  const value = String(m[1] || "").trim();
  return value.length ? value : null;
}

function parseDate(value) {
  if (!value) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // dd/mm/yyyy — the order Kenyan documents use.
  const dmy = /\b(\d{1,2})[/](\d{1,2})[/](\d{4})\b/.exec(value);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return null;
}

/**
 * An amount, or null.
 *
 * Only ever read from a labelled field. Thousands separators are removed, but
 * nothing is inferred: a field that is not a finite number returns null and the
 * document is refused.
 */
function parseAmount(value) {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/[A-Za-z]{3}\s*/g, "")      // a currency code prefix
    .replace(/[^0-9.,-]/g, "")
    .replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function normalizeDocType(value) {
  const v = String(value || "").toUpperCase().replace(/[^A-Z ]/g, "").trim();
  if (TRANSACTION_DOCS.includes(v)) return { type: v, role: "transaction" };
  if (EVIDENCE_DOCS.includes(v)) return { type: v, role: "evidence" };
  return { type: v || null, role: null };
}

/** Read one document. Never throws: a bad file becomes a rejection. */
function readDocument(filename, buffer) {
  const extracted = extractPdfText(buffer);
  if (!extracted.readable) {
    const reason = extracted.reason === "not_a_pdf"
      ? "This file is not a PDF."
      : extracted.reason === "too_large"
        ? "The file is too large to read."
        : "No text could be read from this PDF. It looks like a scan or photo; "
          + "figures cannot be recovered from an image without OCR.";
    return { filename, ok: false, reason };
  }

  const text = extracted.text;
  const docType = normalizeDocType(field(text, "Document Type"));
  if (!docType.role) {
    return {
      filename, ok: false,
      reason: docType.type
        ? `Unrecognised document type "${docType.type}".`
        : "The document does not state its type."
    };
  }

  const date = parseDate(field(text, "Issue Date") || field(text, "Date"));
  const counterparty = field(text, "Counterparty");
  const amount = parseAmount(field(text, "Amount (KES)") || field(text, "Amount")
    || field(text, "Total"));

  const missing = [];
  if (!date) missing.push("date");
  if (!counterparty) missing.push("counterparty");
  if (amount == null) missing.push("amount");
  if (missing.length) {
    /* NAMED, NOT GUESSED. The user learns exactly which field was unreadable,
       so they can fix the document or enter it by hand. */
    return {
      filename, ok: false,
      reason: `Could not read ${missing.join(", ")} from this document.`
    };
  }

  const stated = String(field(text, "Direction") || "").toLowerCase();
  let direction = stated === "inflow" || stated === "outflow" ? stated : null;
  if (!direction) {
    // The document type implies it: a sales invoice is money in, a bill is out.
    if (docType.type === "INVOICE") direction = "inflow";
    else if (docType.type === "VENDOR BILL" || docType.type === "BILL") direction = "outflow";
  }
  if (!direction) {
    return {
      filename, ok: false,
      reason: "The document does not say whether this is money in or money out."
    };
  }

  return {
    filename, ok: true, role: docType.role,
    doc: {
      docType: docType.type,
      docNo: field(text, "Document No"),
      reference: field(text, "Reference"),
      date,
      counterparty,
      description: field(text, "Description") || docType.type,
      amount: direction === "inflow" ? amount : -amount,
      direction,
      currency: (field(text, "Currency") || "KES").toUpperCase().slice(0, 3),
      method: field(text, "Payment Method"),
      dueDate: parseDate(field(text, "Due Date")),
      receiptStated: /^y/i.test(String(field(text, "Receipt Attached") || ""))
    }
  };
}

/** Stable id for a document, so re-uploading the same file cannot duplicate it. */
function sourceRecordId(doc) {
  if (doc.docNo) return `pdf:${doc.docNo}`;
  const h = crypto.createHash("sha256")
    .update([doc.date, doc.amount, doc.counterparty, doc.description].join("|"))
    .digest("hex").slice(0, 16);
  return `pdf:${h}`;
}

/**
 * Import a set of PDF documents as one period.
 *
 * @param {Array<{filename: string, buffer: Buffer}>} files
 * @returns {{ monthlyData: object|null, accepted: Array, rejected: Array, ... }}
 */
function importPdfDocuments({ files = [], period, businessName, currentCashBalance } = {}) {
  const accepted = [];
  const rejected = [];
  const evidence = [];

  files.forEach((f) => {
    const result = readDocument(f.filename, f.buffer);
    if (!result.ok) { rejected.push({ filename: result.filename, reason: result.reason }); return; }
    if (result.role === "evidence") { evidence.push(result.doc); return; }
    accepted.push(result.doc);
  });

  /* OUT-OF-PERIOD DOCUMENTS ARE NOT SILENTLY INCLUDED. A folder often holds a
     stray document from a neighbouring month; counting it would misstate the
     period the user asked about. */
  const outOfPeriod = [];
  const inPeriod = accepted.filter((d) => {
    if (!period) return true;
    if (String(d.date).slice(0, 7) === period) return true;
    outOfPeriod.push({ filename: d.docNo || d.date, reason: `Dated ${d.date}, outside ${period}.` });
    return false;
  });

  if (!inPeriod.length) {
    return {
      monthlyData: null, accepted: [], rejected, outOfPeriod, evidenceCount: evidence.length,
      error: rejected.length
        ? "No readable financial documents were found in this upload."
        : `No documents dated within ${period} were found.`
    };
  }

  /* Attach evidence. A receipt references its document in the description
     ("Payment made - BIL-2026-07-0002"); failing that, an exact match on date,
     amount and counterparty is the same transaction settled. */
  const evidenceFor = new Set();
  evidence.forEach((e) => {
    const ref = /\b((?:INV|BIL|PAY)-[\w-]+)/i.exec(e.description || "");
    if (ref) { evidenceFor.add(ref[1].toUpperCase()); return; }
    evidenceFor.add(`${e.date}|${Math.abs(e.amount)}|${String(e.counterparty).toLowerCase()}`);
  });

  const transactions = inPeriod.map((d) => {
    const hasReceipt = evidenceFor.has(String(d.docNo || "").toUpperCase())
      || evidenceFor.has(`${d.date}|${Math.abs(d.amount)}|${String(d.counterparty).toLowerCase()}`);
    return {
      sourceSystem: "pdf-upload",
      sourceRecordId: sourceRecordId(d),
      recordType: "other",
      date: d.date,
      description: d.description,
      amount: d.amount,
      currency: d.currency,
      counterparty: d.counterparty,
      reference: d.reference,
      dueDate: d.dueDate,
      /* From the FOLDER, not from the document's own claim. A bill that says
         "Receipt Attached: yes" with no receipt beside it is exactly the case
         the missing_receipt rule exists to catch. */
      hasReceipt,
      direction: d.direction
    };
  });

  const inflow = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflow = Math.abs(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0));
  const netIncome = inflow - outflow;

  const cashProvided = currentCashBalance != null && currentCashBalance !== ""
    && Number.isFinite(Number(currentCashBalance));

  const monthlyData = {
    company: { name: businessName || "Uploaded Business", country: "" },
    period: period || null,
    transactions,
    journalEntries: [],
    reconciliations: [],
    statements: {
      cashFlow: { inflow: Math.round(inflow), outflow: Math.round(outflow) },
      profitAndLoss: { netIncome: Math.round(netIncome) },
      balanceSheet: {
        cashAndEquivalents: Math.round(cashProvided ? Number(currentCashBalance) : Math.max(0, netIncome)),
        // Same contract as the CSV importer: the basis travels with the figure.
        cashAndEquivalentsBasis: cashProvided ? "observed" : "derived_from_net_income"
      }
    },
    meta: {
      source: "pdf-upload",
      documentCount: files.length,
      acceptedCount: transactions.length,
      rejectedCount: rejected.length,
      evidenceCount: evidence.length,
      importedAt: new Date().toISOString(),
      cashBasis: cashProvided ? "observed" : "derived_from_net_income"
    }
  };

  return {
    monthlyData, accepted: transactions, rejected, outOfPeriod,
    evidenceCount: evidence.length, error: null
  };
}

module.exports = { importPdfDocuments, readDocument };

#!/usr/bin/env node
// SAMPLE SOURCE DOCUMENTS for analysis testing.
//
//   node scripts/generate-sample-documents.js [outputDir] [firstMonth] [lastMonth]
//
// Writes the kind of paperwork a Kenyan SME actually accumulates — sales
// invoices, vendor bills, payment receipts and bank slips — as PDFs, filed:
//
//     <out>/2026-07/week-1/2026-07-01/INV-2026-07-0001.pdf
//
// month -> week -> day, each day folder named by its own date.
//
// WHY THE NUMBERS ARE NOT RANDOM. Some days carry deliberately planted
// anomalies — a payment made twice, a round-number transfer, an owner drawing
// mixed into business spend, an outlier ten times the usual size. Each one is
// chosen to match a rule the engine actually implements (see
// src/domain/rules/registry.js), and every planted case is listed in the
// month's `_manifest.json`. A fixture that only contains clean data proves
// nothing: it cannot tell a working detector from a broken one.
//
// The generator is DETERMINISTIC. Re-running it reproduces byte-identical
// figures, so a test that asserts "the engine found 3 duplicates in July" stays
// true tomorrow.
//
// SIGN CONVENTION: the bank-statement one, matching src/services/
// csvFinancialImporter.js — money arriving is POSITIVE, money leaving is
// NEGATIVE. Each record also states its direction explicitly so nothing has to
// infer it.

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const OUT_ROOT = process.argv[2] || path.join(process.env.HOME || "/tmp", "Documents", "Doc");
const FIRST_MONTH = process.argv[3] || "2026-07";
const LAST_MONTH = process.argv[4] || "2026-09";

const BUSINESS = {
  name: "ABC Traders Ltd",
  address: "Kenyatta Avenue, Nairobi, Kenya",
  pin: "P051234567X",
  currency: "KES"
};

/* Deterministic PRNG (mulberry32). Math.random() would make every run produce a
   different fixture, so no test could assert anything about its contents. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CUSTOMERS = [
  "BigCo Retail Ltd", "Nakuru Wholesalers", "Coastal Traders Ltd",
  "Highlands Grocers", "Mombasa Imports Ltd", "Thika Distributors"
];
const VENDORS = [
  "Rivera Logistics", "City Power Kenya", "Safaricom Business",
  "Nairobi Stationers", "Kilimani Properties", "Apex Security Services"
];

const DOC = {
  INVOICE: "INVOICE",
  VENDOR_BILL: "VENDOR BILL",
  PAYMENT_RECEIPT: "PAYMENT RECEIPT",
  BANK_RECEIPT: "BANK DEPOSIT SLIP"
};

function daysInMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthsBetween(first, last) {
  const out = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Which week folder a day belongs to: 1-7 -> week-1, 8-14 -> week-2, ... */
function weekOf(day) {
  return Math.floor((day - 1) / 7) + 1;
}

function isWeekend(period, day) {
  const [y, m] = period.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return dow === 0 || dow === 6;
}

function money(n) {
  return Number(n).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Document rendering ────────────────────────────────────────────

/**
 * One source document as a PDF.
 *
 * Fields are rendered as `Label: value` on their own lines, and the amount is
 * repeated unformatted as `Amount (KES): 450000.00`. Extraction should never
 * have to un-format a thousands separator or guess which number on the page is
 * the total.
 */
function writePdf(filePath, doc) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    pdf.pipe(stream);

    const issuerIsUs = doc.direction === "inflow";
    const issuer = issuerIsUs ? BUSINESS.name : doc.counterparty;

    pdf.fontSize(18).text(issuer.toUpperCase());
    pdf.fontSize(9).fillColor("#555")
      .text(issuerIsUs ? BUSINESS.address : "Nairobi, Kenya")
      .text(issuerIsUs ? `PIN: ${BUSINESS.pin}` : "");
    pdf.moveDown(0.8);

    pdf.fillColor("#000").fontSize(15).text(doc.docType);
    pdf.moveDown(0.6);

    const row = (label, value) => {
      pdf.fontSize(10.5).fillColor("#333").text(`${label}: `, { continued: true })
        .fillColor("#000").text(String(value));
    };

    row("Document Type", doc.docType);
    row("Document No", doc.docNo);
    row("Issue Date", doc.date);
    row("Counterparty", doc.counterparty);
    row("Description", doc.description);
    row("Currency", BUSINESS.currency);
    row("Direction", doc.direction);
    pdf.moveDown(0.4);

    // Human-readable, then the machine-readable repeat.
    pdf.fontSize(13).text(`Total: ${BUSINESS.currency} ${money(Math.abs(doc.amount))}`);
    pdf.fontSize(10.5).fillColor("#333")
      .text(`Amount (KES): ${Math.abs(doc.amount).toFixed(2)}`);
    pdf.fillColor("#000");
    pdf.moveDown(0.8);

    row("Payment Method", doc.method);
    row("Reference", doc.reference);
    row("Receipt Attached", doc.hasReceipt ? "yes" : "no");
    if (doc.dueDate) row("Due Date", doc.dueDate);

    pdf.moveDown(1.2);
    pdf.fontSize(8).fillColor("#777").text(
      "Generated sample document for FinGuard analysis testing. Not a real "
      + "financial record and not evidence of any transaction.",
      { width: 460 });

    pdf.end();
  });
}

// ── The month's activity ──────────────────────────────────────────

/**
 * Build one month of transactions, with anomalies planted on chosen days.
 *
 * Every planted case is returned in `anomalies` so the manifest can state what
 * the engine is expected to find, rather than leaving a reviewer to guess
 * which oddities were deliberate.
 */
function buildMonth(period, monthIndex) {
  const rand = rng(0xF16 + monthIndex * 7919);
  const dim = daysInMonth(period);
  const txns = [];
  const anomalies = [];
  let seq = 0;

  const nextNo = (prefix) => `${prefix}-${period}-${String(++seq).padStart(4, "0")}`;
  const pick = (list) => list[Math.floor(rand() * list.length)];

  // Recurring overheads: rent on the 1st, power and connectivity mid-month.
  const fixed = [
    { day: 1, vendor: "Kilimani Properties", desc: "Monthly office rent", amount: -185000 },
    { day: 12, vendor: "City Power Kenya", desc: "Electricity - monthly bill", amount: -42350 },
    { day: 12, vendor: "Safaricom Business", desc: "Internet and mobile lines", amount: -18900 },
    { day: 26, vendor: "Apex Security Services", desc: "Security services", amount: -35000 }
  ];
  fixed.forEach((f) => txns.push({
    day: f.day, counterparty: f.vendor, description: f.desc, amount: f.amount,
    docType: DOC.VENDOR_BILL, method: "Bank Transfer", hasReceipt: true
  }));

  // Ordinary trading: sales on most weekdays, supplier costs through the month.
  for (let day = 1; day <= dim; day += 1) {
    if (isWeekend(period, day)) continue;
    if (rand() < 0.35) continue;               // not every weekday has activity

    const customer = pick(CUSTOMERS);
    const amount = Math.round((45000 + rand() * 260000) / 50) * 50;
    txns.push({
      day, counterparty: customer, description: "Sales invoice - goods supplied",
      amount, docType: DOC.INVOICE, method: "Bank Transfer", hasReceipt: true,
      dueDate: `${period}-${String(Math.min(dim, day + 14)).padStart(2, "0")}`
    });

    if (rand() < 0.45) {
      const vendor = pick(VENDORS);
      txns.push({
        day, counterparty: vendor, description: "Stock purchase",
        amount: -Math.round((20000 + rand() * 90000) / 50) * 50,
        docType: DOC.VENDOR_BILL, method: "M-Pesa", hasReceipt: true
      });
    }
  }

  // ── Planted anomalies ────────────────────────────────────────────
  // Each targets a rule the engine implements. See registry.js.

  /* DUPLICATE PAYMENT — identical date, amount, counterparty and currency.
     The rule requires all four to match, so both copies are written as separate
     documents with distinct reference numbers, exactly as a real double-payment
     appears in the books. */
  const dupDay = 9 + monthIndex;
  const dupAmount = -218500;
  for (let i = 0; i < 2; i += 1) {
    txns.push({
      day: dupDay, counterparty: "Rivera Logistics",
      description: "Freight and haulage - consignment 4471",
      amount: dupAmount, docType: DOC.VENDOR_BILL,
      method: "Bank Transfer", hasReceipt: true
    });
  }
  anomalies.push({
    rule_id: "duplicate_payment", date: `${period}-${String(dupDay).padStart(2, "0")}`,
    detail: `Two identical payments of KES ${money(Math.abs(dupAmount))} to Rivera Logistics.`,
    expect: "one duplicate_payment finding citing both records"
  });

  /* ROUND-NUMBER PAYMENT — exact multiples of 1,000 above materiality. Not
     evidence of anything alone, which is why the rule is medium severity. */
  const roundDay = 17;
  txns.push({
    day: roundDay, counterparty: "Nairobi Stationers",
    description: "Office supplies - bulk order", amount: -150000,
    docType: DOC.VENDOR_BILL, method: "Cheque", hasReceipt: true
  });
  anomalies.push({
    rule_id: "round_number_payment", date: `${period}-${String(roundDay).padStart(2, "0")}`,
    detail: "KES 150,000.00 to Nairobi Stationers — an exact multiple of 1,000.",
    expect: "a round_number_payment finding"
  });

  /* MISSING RECEIPT — a real payment with no supporting document. The receipt
     PDF is deliberately NOT written for this one, so the folder itself is
     missing the evidence, not just a flag in a file. */
  const noReceiptDay = 21;
  txns.push({
    day: noReceiptDay, counterparty: "Rivera Logistics",
    description: "Urgent delivery - no paperwork received", amount: -76400,
    docType: DOC.VENDOR_BILL, method: "Cash", hasReceipt: false
  });
  anomalies.push({
    rule_id: "missing_receipt", date: `${period}-${String(noReceiptDay).padStart(2, "0")}`,
    detail: "KES 76,400.00 cash payment with no receipt document in the folder.",
    expect: "a missing_receipt data-quality finding"
  });

  /* STATISTICAL OUTLIER — well beyond 2 sigma of this month's spread. */
  const outlierDay = 23;
  txns.push({
    day: outlierDay, counterparty: "Mombasa Imports Ltd",
    description: "Bulk container settlement", amount: 1850000,
    docType: DOC.INVOICE, method: "Bank Transfer", hasReceipt: true
  });
  anomalies.push({
    rule_id: "statistical_outlier", date: `${period}-${String(outlierDay).padStart(2, "0")}`,
    detail: "KES 1,850,000.00 from Mombasa Imports — far outside the month's range.",
    expect: "a statistical_outlier finding"
  });

  // Month-specific cases, so the three months are not carbon copies.
  if (monthIndex === 1) {
    /* PERSONAL / BUSINESS MIX — the rule matches on description keywords
       ("owner", "drawings", "personal"). */
    txns.push({
      day: 14, counterparty: "Owner Personal Account",
      description: "Owner drawings - personal withdrawal", amount: -320000,
      docType: DOC.PAYMENT_RECEIPT, method: "Bank Transfer", hasReceipt: false
    });
    anomalies.push({
      rule_id: "mixed_personal_business", date: `${period}-14`,
      detail: "KES 320,000.00 described as owner drawings / personal withdrawal.",
      expect: "a mixed_personal_business finding"
    });

    /* VENDOR CONCENTRATION — one supplier taking most of the month's spend. */
    [4, 11, 18, 25].forEach((day) => txns.push({
      day, counterparty: "Rivera Logistics",
      description: "Exclusive haulage contract - weekly settlement",
      amount: -445000, docType: DOC.VENDOR_BILL,
      method: "Bank Transfer", hasReceipt: true
    }));
    anomalies.push({
      rule_id: "vendor_concentration", date: period,
      detail: "Rivera Logistics takes the large majority of this month's spend.",
      expect: "a vendor_concentration finding"
    });
  }

  if (monthIndex === 2) {
    /* CUSTOMER CONCENTRATION — one buyer dominating revenue. */
    [3, 10, 17, 24].forEach((day) => txns.push({
      day, counterparty: "BigCo Retail Ltd",
      description: "Framework agreement - scheduled delivery",
      amount: 1240000, docType: DOC.INVOICE,
      method: "Bank Transfer", hasReceipt: true,
      dueDate: `${period}-${String(Math.min(dim, day + 14)).padStart(2, "0")}`
    }));
    anomalies.push({
      rule_id: "customer_concentration", date: period,
      detail: "BigCo Retail Ltd accounts for the large majority of revenue.",
      expect: "a customer_concentration finding"
    });

    // A second duplicate, on a different vendor, to prove detection is general.
    for (let i = 0; i < 2; i += 1) {
      txns.push({
        day: 27, counterparty: "Apex Security Services",
        description: "Quarterly alarm monitoring", amount: -96000,
        docType: DOC.VENDOR_BILL, method: "M-Pesa", hasReceipt: true
      });
    }
    anomalies.push({
      rule_id: "duplicate_payment", date: `${period}-27`,
      detail: "Two identical payments of KES 96,000.00 to Apex Security Services.",
      expect: "a second duplicate_payment finding"
    });
  }

  // Stable ordering, then document numbers assigned in date order.
  txns.sort((a, b) => a.day - b.day
    || String(a.counterparty).localeCompare(String(b.counterparty))
    || a.amount - b.amount);

  txns.forEach((t) => {
    const prefix = t.amount > 0 ? "INV" : (t.docType === DOC.PAYMENT_RECEIPT ? "PAY" : "BIL");
    t.docNo = nextNo(prefix);
    t.date = `${period}-${String(t.day).padStart(2, "0")}`;
    t.direction = t.amount > 0 ? "inflow" : "outflow";
    t.reference = `${t.method.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4)}${
      String(1000 + (t.docNo.charCodeAt(t.docNo.length - 1) * 7) % 8999)}`;
  });

  return { txns, anomalies };
}

// ── Writing the tree ──────────────────────────────────────────────

async function writeMonth(period, monthIndex) {
  const { txns, anomalies } = buildMonth(period, monthIndex);
  const monthDir = path.join(OUT_ROOT, period);
  fs.mkdirSync(monthDir, { recursive: true });

  const byDay = new Map();
  txns.forEach((t) => {
    if (!byDay.has(t.day)) byDay.set(t.day, []);
    byDay.get(t.day).push(t);
  });

  let pdfCount = 0;
  for (const [day, dayTxns] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const dateStr = `${period}-${String(day).padStart(2, "0")}`;
    const dayDir = path.join(monthDir, `week-${weekOf(day)}`, dateStr);
    fs.mkdirSync(dayDir, { recursive: true });

    for (const t of dayTxns) {
      await writePdf(path.join(dayDir, `${t.docNo}.pdf`), t);
      pdfCount += 1;

      /* A settled invoice also produces a bank slip, and a paid bill a payment
         receipt — the corroborating paperwork a real folder contains. The one
         transaction deliberately marked hasReceipt:false gets neither, so the
         evidence really is absent rather than merely flagged. */
      if (t.hasReceipt) {
        const companion = t.amount > 0
          ? { docType: DOC.BANK_RECEIPT, prefix: "BNK", desc: `Deposit - ${t.docNo}` }
          : { docType: DOC.PAYMENT_RECEIPT, prefix: "RCP", desc: `Payment made - ${t.docNo}` };
        await writePdf(path.join(dayDir, `${companion.prefix}-${t.docNo.slice(4)}.pdf`),
          Object.assign({}, t, {
            docType: companion.docType,
            docNo: `${companion.prefix}-${t.docNo.slice(4)}`,
            description: companion.desc
          }));
        pdfCount += 1;
      }
    }

    /* A CSV of the same day, alongside the PDFs. PDF ingestion is not built
       yet, so without this the fixture could not be analysed at all today. It
       is the same data, in the format the uploader already parses. */
    const csv = ["Date,Description,Amount,Counterparty"]
      .concat(dayTxns.map((t) => [
        t.date, `"${t.description.replace(/"/g, '""')}"`, t.amount, `"${t.counterparty}"`
      ].join(",")))
      .join("\n");
    fs.writeFileSync(path.join(dayDir, `${dateStr}.csv`), csv + "\n");
  }

  // A whole-month CSV, for uploading the period in one go.
  const monthCsv = ["Date,Description,Amount,Counterparty"]
    .concat(txns.map((t) => [
      t.date, `"${t.description.replace(/"/g, '""')}"`, t.amount, `"${t.counterparty}"`
    ].join(",")))
    .join("\n");
  fs.writeFileSync(path.join(monthDir, `${period}-full-month.csv`), monthCsv + "\n");

  const inflow = txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflow = Math.abs(txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0));

  const manifest = {
    period,
    business: BUSINESS.name,
    currency: BUSINESS.currency,
    generated_by: "scripts/generate-sample-documents.js",
    deterministic: true,
    sign_convention: "positive = money in (credit), negative = money out (debit)",
    totals: {
      transactions: txns.length,
      documents_pdf: pdfCount,
      inflow: Math.round(inflow),
      outflow: Math.round(outflow),
      net: Math.round(inflow - outflow)
    },
    /* What the engine SHOULD find. A fixture that does not state its expected
       findings cannot distinguish a working detector from a silent one. */
    planted_anomalies: anomalies,
    note: "Sample data for testing. Not real financial records."
  };
  fs.writeFileSync(path.join(monthDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n");

  return { period, txns: txns.length, pdfs: pdfCount, days: byDay.size, anomalies };
}

(async () => {
  const months = monthsBetween(FIRST_MONTH, LAST_MONTH);
  console.log(`\nWriting sample documents to ${OUT_ROOT}`);
  console.log(`Months: ${months.join(", ")}\n`);

  const summary = [];
  for (let i = 0; i < months.length; i += 1) {
    const result = await writeMonth(months[i], i);
    summary.push(result);
    console.log(`  ${result.period}  ${String(result.days).padStart(2)} days  `
      + `${String(result.txns).padStart(3)} transactions  `
      + `${String(result.pdfs).padStart(3)} PDFs  `
      + `${result.anomalies.length} planted anomalies`);
  }

  fs.writeFileSync(path.join(OUT_ROOT, "_README.md"), [
    "# FinGuard sample source documents",
    "",
    "Generated by `scripts/generate-sample-documents.js`. **Not real financial",
    "records.** Re-running the generator reproduces these figures exactly.",
    "",
    "## Layout",
    "",
    "```",
    "<month>/                     e.g. 2026-07",
    "  _manifest.json             totals and the anomalies planted this month",
    "  2026-07-full-month.csv     the whole period, for a single upload",
    "  week-1/ … week-5/",
    "    2026-07-01/              a day, named by its own date",
    "      INV-2026-07-0001.pdf   sales invoice",
    "      BNK-2026-07-0001.pdf   bank deposit slip for that invoice",
    "      BIL-2026-07-0002.pdf   vendor bill",
    "      RCP-2026-07-0002.pdf   payment receipt for that bill",
    "      2026-07-01.csv         the same day in CSV",
    "```",
    "",
    "Weeks are calendar blocks of the month: days 1–7 are `week-1`, 8–14",
    "`week-2`, and so on.",
    "",
    "## Planted anomalies",
    "",
    "Each month contains deliberate irregularities, each matching a rule the",
    "engine implements. `_manifest.json` lists them per month with the finding",
    "each should produce. One payment is written with **no receipt document at",
    "all**, so the evidence is genuinely absent from the folder.",
    "",
    summary.map((s) => `- **${s.period}** — ${s.txns} transactions, ${s.pdfs} PDFs, `
      + `${s.anomalies.length} planted: ${[...new Set(s.anomalies.map((a) => a.rule_id))].join(", ")}`).join("\n"),
    "",
    "## Sign convention",
    "",
    "Bank-statement convention, matching `src/services/csvFinancialImporter.js`:",
    "money arriving is **positive**, money leaving is **negative**.",
    ""
  ].join("\n"));

  console.log(`\nDone. ${summary.reduce((s, x) => s + x.pdfs, 0)} PDFs across `
    + `${months.length} months.\n`);
})().catch((err) => {
  console.error("\nGeneration failed:", err.message);
  process.exit(1);
});

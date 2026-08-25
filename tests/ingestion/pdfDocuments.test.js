// PDF SOURCE DOCUMENTS -> a period.
//
// Users keep invoices and receipts, not CSVs. This is the path that reads them.
//
// The whole risk of this feature is one thing: a PDF importer that GUESSES.
// Picking the largest number on a page as "the total" would put fabricated
// figures into an analysis presented as authoritative — worse than refusing the
// file, and invisible to the user. So most of what follows asserts refusal.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const PDFDocument = require("pdfkit");

const { extractPdfText } = require("../../src/services/pdfTextExtract");
const { importPdfDocuments, readDocument } = require("../../src/services/pdfDocumentImporter");

/** Render a document PDF in memory, the same shape the generator writes. */
function makePdf(lines) {
  return new Promise((resolve) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    lines.forEach((l) => pdf.fontSize(11).text(l));
    pdf.end();
  });
}

function docLines(over = {}) {
  const d = Object.assign({
    type: "VENDOR BILL", no: "BIL-2026-07-0009", date: "2026-07-09",
    counterparty: "Rivera Logistics", description: "Freight and haulage",
    currency: "KES", direction: "outflow", amount: "218500.00",
    method: "Bank Transfer", reference: "BANK1399", receipt: "yes"
  }, over);
  return [
    `Document Type: ${d.type}`,
    `Document No: ${d.no}`,
    `Issue Date: ${d.date}`,
    `Counterparty: ${d.counterparty}`,
    `Description: ${d.description}`,
    `Currency: ${d.currency}`,
    `Direction: ${d.direction}`,
    `Amount (KES): ${d.amount}`,
    `Payment Method: ${d.method}`,
    `Reference: ${d.reference}`,
    `Receipt Attached: ${d.receipt}`
  ].filter((l) => !/: (undefined|null)$/.test(l));
}

const file = async (filename, over) => ({ filename, buffer: await makePdf(docLines(over)) });

// ── Extraction ────────────────────────────────────────────────────

test("[PDF1] a text PDF is read; a non-PDF and an image-only PDF are not", async () => {
  const buf = await makePdf(docLines());
  const got = extractPdfText(buf);
  assert.equal(got.readable, true);
  assert.match(got.text, /Rivera Logistics/);
  assert.match(got.text, /218500\.00/);

  const notPdf = extractPdfText(Buffer.from("Date,Amount\n2026-07-09,100"));
  assert.equal(notPdf.readable, false);
  assert.equal(notPdf.reason, "not_a_pdf");

  /* A scan carries an image and no text. It must report unreadable rather than
     returning "" and letting a caller treat it as an empty document. */
  const imageOnly = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("stream\n"), zlib.deflateSync(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    Buffer.from("\nendstream\n%%EOF\n")
  ]);
  assert.equal(extractPdfText(imageOnly).readable, false);
});

test("[PDF2] a stream whose data ends in a newline is not truncated", async () => {
  /* THE REGRESSION. Boundaries were found with /stream\\r?\\n([\\s\\S]*?)\\r?\\nendstream/.
     When the compressed bytes themselves end in 0x0A the lazy match stops at
     THAT byte and treats it as the separator, so zlib gets a stream one byte
     short, fails with "unexpected end of file", and the document is reported as
     an unreadable scan. It hit about one generated file in fifty. */
  const payload = Buffer.from("BT (Amount (KES): 4200.00) Tj ET\n");   // ends with \n
  const deflated = zlib.deflateSync(payload);
  assert.equal(deflated[deflated.length - 1] !== undefined, true);

  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("stream\n"), deflated, Buffer.from("\nendstream\n%%EOF\n")
  ]);
  const got = extractPdfText(pdf);
  assert.equal(got.readable, true, "the stream inflated despite the trailing EOL");
  assert.match(got.text, /4200\.00/);
});

// ── Refusal ───────────────────────────────────────────────────────

test("[PDF3] a document missing a required field is REFUSED, and says which",
  async () => {
    const noAmount = await makePdf(docLines({ amount: undefined }));
    const r1 = readDocument("bad-1.pdf", noAmount);
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /amount/, "the unreadable field is named");

    const noCounterparty = await makePdf(docLines({ counterparty: undefined }));
    const r2 = readDocument("bad-2.pdf", noCounterparty);
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /counterparty/);

    const noDate = await makePdf(docLines({ date: undefined }));
    assert.equal(readDocument("bad-3.pdf", noDate).ok, false);
  });

test("[PDF4] an amount is never inferred from stray numbers on the page", async () => {
  /* A page full of figures — a reference, a phone number, a total — with no
     labelled amount field. The importer must refuse rather than pick one. */
  const pdf = await makePdf([
    "RIVERA LOGISTICS", "Invoice 4471", "Tel 0722 000 111",
    "Document Type: VENDOR BILL",
    "Issue Date: 2026-07-09",
    "Counterparty: Rivera Logistics",
    "218500.00", "99,000", "1,250,000"
  ]);
  const r = readDocument("ambiguous.pdf", pdf);
  assert.equal(r.ok, false, "no labelled amount means no amount");
  assert.match(r.reason, /amount/);
});

test("[PDF5] a refused document contributes nothing to the totals", async () => {
  const good = await file("good.pdf");
  const bad = { filename: "scan.pdf", buffer: Buffer.from("%PDF-1.4\nnothing here\n") };
  const out = importPdfDocuments({ files: [good, bad], period: "2026-07" });

  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].filename, "scan.pdf");
  assert.equal(out.monthlyData.statements.cashFlow.outflow, 218500,
    "the refused file added nothing");
});

// ── Transactions vs evidence ──────────────────────────────────────

test("[PDF6] an invoice and its receipt are ONE transaction, not two", async () => {
  /* Double-counting is the quiet failure here: a folder holds a bill and its
     payment receipt for the same money, and importing both doubles the
     period's outflow with nothing on screen to show it. */
  const bill = await file("BIL-1.pdf");
  const receipt = await file("RCP-1.pdf", {
    type: "PAYMENT RECEIPT", no: "RCP-2026-07-0009",
    description: "Payment made - BIL-2026-07-0009"
  });

  const out = importPdfDocuments({ files: [bill, receipt], period: "2026-07" });
  assert.equal(out.accepted.length, 1, "one transaction");
  assert.equal(out.evidenceCount, 1, "one supporting document");
  assert.equal(out.monthlyData.statements.cashFlow.outflow, 218500,
    "counted once, not 437,000");
  assert.equal(out.accepted[0].hasReceipt, true, "the receipt attached to it");
});

test("[PDF7] hasReceipt comes from the FOLDER, not the document's own claim",
  async () => {
    /* The bill says "Receipt Attached: yes" and no receipt is present. Trusting
       the claim would silence the missing_receipt rule for exactly the payments
       it exists to catch. */
    const lying = await file("BIL-2.pdf", { receipt: "yes" });
    const out = importPdfDocuments({ files: [lying], period: "2026-07" });
    assert.equal(out.accepted[0].hasReceipt, false,
      "no receipt document is present, whatever the bill claims");
  });

test("[PDF8] direction decides the sign, and an invoice is money IN", async () => {
  const invoice = await file("INV-1.pdf", {
    type: "INVOICE", no: "INV-2026-07-0001", direction: "inflow",
    counterparty: "BigCo Retail Ltd", amount: "450000.00"
  });
  const out = importPdfDocuments({ files: [invoice], period: "2026-07" });
  assert.equal(out.accepted[0].amount, 450000, "positive: money arriving");
  assert.equal(out.accepted[0].direction, "inflow");
  assert.equal(out.monthlyData.statements.cashFlow.inflow, 450000);
  assert.equal(out.monthlyData.statements.cashFlow.outflow, 0);
});

// ── Period boundaries ─────────────────────────────────────────────

test("[PDF9] a document from another month is excluded and REPORTED", async () => {
  const inPeriod = await file("in.pdf", { date: "2026-07-09" });
  const stray = await file("stray.pdf", { date: "2026-06-28", no: "BIL-2026-06-0044" });

  const out = importPdfDocuments({ files: [inPeriod, stray], period: "2026-07" });
  assert.equal(out.accepted.length, 1, "only July counted");
  assert.equal(out.outOfPeriod.length, 1, "and the stray is named, not dropped");
  assert.match(out.outOfPeriod[0].reason, /2026-06-28/);
});

test("[PDF10] an upload with nothing readable fails loudly", async () => {
  const out = importPdfDocuments({
    files: [{ filename: "a.pdf", buffer: Buffer.from("%PDF-1.4\n\n") }],
    period: "2026-07"
  });
  assert.equal(out.monthlyData, null, "no dataset is produced");
  assert.match(out.error, /No readable financial documents/);
  assert.equal(out.rejected.length, 1);
});

// ── Contract with the rest of the pipeline ────────────────────────

test("[PDF11] the dataset matches the CSV importer's contract", async () => {
  const out = importPdfDocuments({
    files: [await file("a.pdf")], period: "2026-07", businessName: "ABC Traders Ltd"
  });
  const d = out.monthlyData;

  assert.equal(d.meta.source, "pdf-upload", "provenance is stated");
  assert.equal(d.period, "2026-07");
  assert.equal(d.transactions[0].sourceSystem, "pdf-upload");
  assert.ok(d.transactions[0].sourceRecordId, "every record is citable by a finding");

  /* The cash basis must travel with the figure, exactly as the CSV path does —
     a balance nobody supplied is an estimate, not a measurement. */
  assert.equal(d.statements.balanceSheet.cashAndEquivalentsBasis,
    "derived_from_net_income", "no balance was supplied");

  const withCash = importPdfDocuments({
    files: [], period: "2026-07", currentCashBalance: 2400000
  });
  assert.equal(withCash.monthlyData, null, "no documents, no dataset");
});

test("[PDF12] re-uploading the same document does not create a second record",
  async () => {
    const a = await file("copy-a.pdf");
    const b = await file("copy-b.pdf");          // same document, different filename
    const out = importPdfDocuments({ files: [a, b], period: "2026-07" });
    const ids = out.accepted.map((t) => t.sourceRecordId);
    assert.equal(new Set(ids).size, 1,
      "the document number identifies the record, so both resolve to one id");
  });

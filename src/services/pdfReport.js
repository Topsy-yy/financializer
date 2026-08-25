// PDF rendering layer: takes a normalized report model (from reportFormatter)
// and draws a branded, investor-ready PDF with pdfkit. Returns a Buffer.
// Light theme on purpose — these get printed and emailed to investors.

const PDFDocument = require("pdfkit");

const C = {
  brand: "#7c3aed",
  brandInk: "#e9d5ff",
  text: "#111827",
  muted: "#6b7280",
  border: "#e5e7eb",
  soft: "#f9fafb",
  green: "#16a34a",
  amber: "#d97706",
  red: "#dc2626",
  white: "#ffffff"
};

const M = 50; // page margin

function money(n) {
  if (n == null || isNaN(Number(n))) return "—";
  return "KES " + Math.round(Number(n)).toLocaleString("en-US");
}

function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scoreColor(score) {
  if (score == null) return C.muted;
  if (score >= 70) return C.green;
  if (score >= 40) return C.amber;
  return C.red;
}

function riskColor(level) {
  const l = String(level || "").toLowerCase();
  if (/high|critical|poor|at risk/.test(l)) return C.red;
  if (/medium|fair|moderate|watch/.test(l)) return C.amber;
  if (/low|good|excellent|strong|healthy/.test(l)) return C.green;
  return C.muted;
}

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ok" || s === "done" || s === "resolved") return C.green;
  if (s === "review" || s === "pending") return C.amber;
  return C.red; // action-needed / flagged
}

function priorityColor(p) {
  const s = String(p || "").toLowerCase();
  if (/urgent|critical|high/.test(s)) return C.red;
  if (/normal|medium/.test(s)) return C.amber;
  return C.green;
}

function renderReportPdf(model) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true });
      const chunks = [];
      doc.on("data", (d) => chunks.push(d));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageW = doc.page.width;
      const contentW = pageW - M * 2;
      const bottomLimit = () => doc.page.height - 64;

      function ensureSpace(h) {
        if (doc.y + h > bottomLimit()) doc.addPage();
      }

      // ── Branded header band (page 1) ──
      doc.rect(0, 0, pageW, 96).fill(C.brand);
      // simple shield mark
      doc.save();
      doc.translate(M, 30).scale(1);
      doc.path("M 12 0 L 24 5 L 24 15 C 24 26 17 33 12 35 C 7 33 0 26 0 15 L 0 5 Z")
        .fill(C.white);
      doc.restore();
      doc.fillColor(C.white).font("Helvetica-Bold").fontSize(20).text(model.brand, M + 36, 30);
      doc.font("Helvetica").fontSize(11).fillColor(C.brandInk).text(model.title, M + 36, 56);
      doc.fillColor(C.text);
      doc.y = 120;

      // ── Company + meta ──
      doc.font("Helvetica-Bold").fontSize(17).fillColor(C.text).text(model.company, M, doc.y);
      if (model.address) doc.font("Helvetica").fontSize(9).fillColor(C.muted).text(model.address, M);
      doc.font("Helvetica").fontSize(9.5).fillColor(C.muted)
        .text("Reporting period: " + model.period + "     Generated: " + fmtDate(model.generatedAt), M, doc.y + 2);
      doc.moveDown(1);

      // ── Score + risk stat boxes ──
      const boxW = (contentW - 16) / 2;
      const boxY = doc.y;
      statBox(doc, M, boxY, boxW, "Financial Health Score",
        model.healthScore != null ? model.healthScore + " / 100" : "N/A",
        model.healthCategory || "", scoreColor(model.healthScore), model.healthScore);
      statBox(doc, M + boxW + 16, boxY, boxW, "Overall Risk Level",
        String(model.riskLevel).toUpperCase(), "", riskColor(model.riskLevel), null);
      doc.y = boxY + 86;

      // ── Sections ──
      section(doc, "Executive Summary", contentW);
      paragraph(doc, model.executiveSummary, contentW);

      section(doc, "Key Findings", contentW);
      bullets(doc, model.keyFindings, "No material findings this period.", contentW);

      section(doc, "Risk Breakdown", contentW);
      kvTable(doc, model.riskBreakdown.map((r) => [r.label, String(r.value)]), contentW);

      /* LIMITATIONS, BEFORE THE FIGURES THEY QUALIFY.
         A reader who sees "Cash runway: —" with no explanation will supply
         their own, and "the business has none" is the obvious guess. This
         section says what was not measured and why, in the server's own
         wording, so the dashes further down are read correctly. Rendered only
         when there is something to disclose. */
      if (model.disclosure && model.disclosure.limitations
          && model.disclosure.limitations.length) {
        section(doc, "Limitations of this report", contentW);
        bullets(doc, model.disclosure.limitations
          .map((l) => l.detail
            || (l.metric ? `${l.metric} is not available (${l.reason || "no reason given"})`
              : `${l.input} was ${l.basis || "derived"}`))
          .filter(Boolean),
        "", contentW);
        bullets(doc, ["This analysis is not based on fully observed data. "
          + "Figures shown as \u2014 were not measured, and must not be read as zero."],
        "", contentW);
      }

      section(doc, "Cash Flow Summary", contentW);
      kvTable(doc, [
        ["Net cash flow", money(model.cashflow.net_cash_flow)],
        ["Monthly burn", money(model.cashflow.monthly_burn)],
        ["Cash runway", model.cashflow.runway_days != null ? model.cashflow.runway_days + " days" : "—"],
        ["Overdue receivables", money(model.cashflow.overdue_receivables)]
      ], contentW);

      section(doc, "Fraud Indicators", contentW);
      bullets(doc, model.fraudIndicators, "No fraud indicators detected this period.", contentW);

      section(doc, "Missing Information Checklist", contentW);
      checklistTable(doc, model.checklist, contentW);

      section(doc, "AI Recommendations", contentW);
      bullets(doc, model.recommendations, "No recommendations at this time.", contentW);

      section(doc, "Follow-up Tasks", contentW);
      tasksTable(doc, model.followUpTasks, contentW);

      // ── Footer on every page ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const fy = doc.page.height - 42;
        doc.font("Helvetica").fontSize(8).fillColor(C.muted);
        doc.text("FinGuard AI — generated " + fmtDate(model.generatedAt), M, fy, { width: contentW - 80, lineBreak: false });
        doc.text("Page " + (i + 1) + " of " + range.count, pageW - M - 80, fy, { width: 80, align: "right", lineBreak: false });
        doc.text("Decision support only — not audit or investment advice.", M, fy + 11, { width: contentW, lineBreak: false });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });

  // ── helpers ──
  function statBox(doc, x, y, w, label, value, sub, color, scoreForBar) {
    doc.roundedRect(x, y, w, 74, 8).lineWidth(1).fillAndStroke(C.soft, C.border);
    doc.font("Helvetica").fontSize(9).fillColor(C.muted).text(label, x + 14, y + 12, { width: w - 28 });
    doc.font("Helvetica-Bold").fontSize(20).fillColor(color).text(value, x + 14, y + 26, { width: w - 28, lineBreak: false });
    if (sub) doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(sub, x + 14, y + 50, { width: w - 28, lineBreak: false });
    if (scoreForBar != null) {
      const barX = x + 14, barY = y + 62, barW = w - 28;
      doc.roundedRect(barX, barY, barW, 5, 2.5).fill(C.border);
      doc.roundedRect(barX, barY, Math.max(4, barW * Math.min(100, Math.max(0, scoreForBar)) / 100), 5, 2.5).fill(color);
    }
    doc.fillColor(C.text);
  }

  function section(doc, title, contentW) {
    ensureSpaceOuter(doc, 44);
    doc.moveDown(0.6);
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(12.5).fillColor(C.brand).text(title, M, y);
    doc.moveTo(M, doc.y + 2).lineTo(M + contentW, doc.y + 2).lineWidth(1).strokeColor(C.border).stroke();
    doc.moveDown(0.5);
    doc.fillColor(C.text);
  }

  function paragraph(doc, text, contentW) {
    ensureSpaceOuter(doc, 30);
    doc.font("Helvetica").fontSize(10).fillColor(C.text).text(String(text || "—"), M, doc.y, { width: contentW, align: "left", lineGap: 2 });
  }

  function bullets(doc, items, emptyText, contentW) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) { paragraph(doc, emptyText, contentW); return; }
    doc.font("Helvetica").fontSize(10).fillColor(C.text);
    list.forEach((it) => {
      ensureSpaceOuter(doc, 16);
      const y = doc.y;
      doc.circle(M + 3, y + 5, 1.6).fill(C.brand);
      doc.fillColor(C.text).text(String(it), M + 14, y, { width: contentW - 14, lineGap: 1.5 });
    });
  }

  function kvTable(doc, rows, contentW) {
    const labelW = contentW * 0.55;
    doc.font("Helvetica").fontSize(10);
    rows.forEach((r, idx) => {
      ensureSpaceOuter(doc, 20);
      const y = doc.y;
      if (idx % 2 === 0) doc.rect(M, y - 2, contentW, 18).fill(C.soft);
      doc.fillColor(C.muted).text(String(r[0]), M + 8, y + 1, { width: labelW - 8 });
      doc.fillColor(C.text).font("Helvetica-Bold").text(String(r[1]), M + labelW, y + 1, { width: contentW - labelW - 8, align: "right" });
      doc.font("Helvetica");
      doc.y = y + 18;
    });
    doc.moveDown(0.3);
  }

  function badge(doc, x, y, text, color) {
    doc.font("Helvetica-Bold").fontSize(7.5);
    const t = String(text || "").toUpperCase();
    const w = doc.widthOfString(t) + 12;
    doc.roundedRect(x, y, w, 13, 6.5).fill(color);
    doc.fillColor(C.white).text(t, x + 6, y + 3, { lineBreak: false });
    doc.fillColor(C.text);
    return w;
  }

  function checklistTable(doc, items, contentW) {
    if (!items || !items.length) { paragraph(doc, "No checklist items.", contentW); return; }
    const cnW = 60, stW = 120;
    const itemW = contentW - cnW - stW;
    items.forEach((ci, idx) => {
      ensureSpaceOuter(doc, 20);
      const y = doc.y;
      if (idx % 2 === 0) doc.rect(M, y - 2, contentW, 18).fill(C.soft);
      doc.font("Helvetica").fontSize(10).fillColor(C.text).text(String(ci.item), M + 8, y + 1, { width: itemW - 8 });
      doc.fillColor(C.muted).text(String(ci.count), M + itemW, y + 1, { width: cnW, align: "center" });
      badge(doc, M + itemW + cnW, y, String(ci.status || "").replace(/-/g, " "), statusColor(ci.status));
      doc.y = y + 18;
    });
    doc.moveDown(0.3);
  }

  function tasksTable(doc, tasks, contentW) {
    if (!tasks || !tasks.length) { paragraph(doc, "No pending follow-up tasks.", contentW); return; }
    const prW = 70, ownW = 100, dueW = 80;
    const taskW = contentW - prW - ownW - dueW;
    // header
    ensureSpaceOuter(doc, 20);
    let y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.muted);
    doc.text("PRIORITY", M + 4, y, { width: prW });
    doc.text("TASK", M + prW, y, { width: taskW });
    doc.text("OWNER", M + prW + taskW, y, { width: ownW });
    doc.text("DUE", M + prW + taskW + ownW, y, { width: dueW });
    doc.y = y + 15;
    doc.moveTo(M, doc.y).lineTo(M + contentW, doc.y).lineWidth(0.5).strokeColor(C.border).stroke();
    doc.moveDown(0.2);

    tasks.forEach((t) => {
      const taskText = String(t.task || "—");
      doc.font("Helvetica").fontSize(9.5);
      const th = doc.heightOfString(taskText, { width: taskW - 6 });
      const rowH = Math.max(18, th + 6);
      ensureSpaceOuter(doc, rowH);
      y = doc.y;
      badge(doc, M + 4, y + 1, String(t.priority || "normal"), priorityColor(t.priority));
      doc.fillColor(C.text).font("Helvetica").fontSize(9.5).text(taskText, M + prW, y, { width: taskW - 6, lineGap: 1 });
      doc.fillColor(C.muted).fontSize(9).text(String(t.owner || "—"), M + prW + taskW, y, { width: ownW });
      doc.text(String(t.due || "—"), M + prW + taskW + ownW, y, { width: dueW });
      doc.fillColor(C.text);
      doc.y = y + rowH;
    });
    doc.moveDown(0.3);
  }

  // ensureSpace usable inside the helpers above (closure over doc's page metrics)
  function ensureSpaceOuter(doc, h) {
    if (doc.y + h > doc.page.height - 64) doc.addPage();
  }
}

module.exports = { renderReportPdf };

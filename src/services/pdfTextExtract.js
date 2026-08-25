// PDF -> text.
//
// Promoted from the test helper that verifies generated reports, because the
// uploader now has to READ pdfs, not only write them.
//
// WHAT IT HANDLES. Text-based PDFs: content streams are Flate-compressed, and
// producers write glyphs either as hex runs inside TJ arrays
// (`[<466f6c6c6f> 15 <772d7570>] TJ`) or as literal `(string) Tj`. Both forms
// are decoded.
//
// WHAT IT DOES NOT HANDLE, and must never pretend to: a scanned or
// photographed document. Those carry an image, not text, and recovering figures
// from them needs OCR. This returns empty text for such a file, and the caller
// REFUSES it rather than importing a document it could not read. Guessing at an
// invoice total is the one failure this whole codebase exists to prevent.

const zlib = require("node:zlib");

/** Refuse absurd input before doing any work. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_STREAMS = 500;

function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4
    && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * PDF literal strings — `(like this)` — from a content stream.
 *
 * Scanned rather than matched with a regex, because a PDF literal may contain
 * BALANCED nested parentheses unescaped, and that is not a rare edge case here:
 * an invoice line reading `(Amount (KES): 4200.00)` is exactly the shape this
 * importer cares about. A `[^()]`-style pattern skips those strings silently,
 * so the figure simply never appears and the document looks like an unreadable
 * scan.
 */
function scanLiteralStrings(ops) {
  const out = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i] !== "(") continue;
    let depth = 1;
    let j = i + 1;
    let buf = "";
    while (j < ops.length && depth > 0) {
      const ch = ops[j];
      if (ch === "\\") {                 // an escaped character is taken verbatim
        buf += ops[j + 1] === undefined ? "" : ops[j + 1];
        j += 2;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") { depth -= 1; if (depth === 0) break; }
      buf += ch;
      j += 1;
    }
    if (depth === 0) {
      // Only a string actually painted by a text operator is page content.
      if (/^\s*(T[jJ]|'|")/.test(ops.slice(j + 1, j + 6))) out.push(buf);
      i = j;
    }
  }
  return out;
}

/**
 * Extract what text can be recovered.
 *
 * @returns {{ text: string, streams: number, readable: boolean }}
 *   `readable` is false when nothing could be decoded — an image-only PDF, or
 *   one whose encoding this does not support. It is NOT an error: it is the
 *   signal the caller needs to decline the file honestly.
 */
function extractPdfText(buffer) {
  if (!looksLikePdf(buffer)) {
    return { text: "", streams: 0, readable: false, reason: "not_a_pdf" };
  }
  if (buffer.length > MAX_BYTES) {
    return { text: "", streams: 0, readable: false, reason: "too_large" };
  }

  const raw = buffer.toString("latin1");
  let ops = "";
  let streams = 0;

  /* STREAM BOUNDARIES ARE FOUND BY INDEX, NOT BY A NON-GREEDY REGEX.
   *
   * `/stream\r?\n([\s\S]*?)\r?\nendstream/` looks right and quietly corrupts
   * data: when the compressed bytes themselves END in 0x0A, the lazy match
   * stops at THAT byte and treats it as the separator, handing zlib a stream
   * one byte short. It fails with "unexpected end of file" and the document
   * reads as an unreadable scan. It happened on roughly one file in fifty —
   * frequent enough to lose real documents, rare enough to look like a quirk
   * of the file rather than a bug here. */
  let cursor = 0;
  while (streams < MAX_STREAMS) {
    const open = raw.indexOf("stream", cursor);
    if (open === -1) break;
    const close = raw.indexOf("endstream", open + 6);
    if (close === -1) break;

    // Skip the single EOL the spec puts after the `stream` keyword.
    let dataStart = open + 6;
    if (raw[dataStart] === "\r") dataStart += 1;
    if (raw[dataStart] === "\n") dataStart += 1;

    const chunk = Buffer.from(raw.slice(dataStart, close), "latin1");
    cursor = close + 9;
    streams += 1;

    try {
      /* Z_SYNC_FLUSH inflates what it can instead of refusing a stream whose
         final block is truncated or which carries the trailing EOL that
         precedes `endstream`. Both are normal in real PDFs. */
      ops += zlib.inflateSync(chunk, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
        .toString("latin1") + "\n";
    } catch {
      /* Fonts, images and already-plain streams are not deflate text. An
         uncompressed content stream still yields its operators, so it is kept
         rather than dropped. */
      const plain = chunk.toString("latin1");
      if (/T[jJ]/.test(plain)) ops += plain + "\n";
    }
  }

  /* Hex glyph runs. Each `<...>` inside a TJ array is a fragment of a word, so
     they are concatenated with no separator — inserting spaces here would split
     words that were never split. */
  const hex = (ops.match(/<([0-9a-fA-F]+)>/g) || [])
    .map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1"))
    .join("");

  const literal = scanLiteralStrings(ops).join(" ");

  const text = (hex + " " + literal).replace(/\\([()\\])/g, "$1").trim();
  return {
    text,
    streams,
    readable: text.length > 0,
    reason: text.length ? null : "no_extractable_text"
  };
}

module.exports = { extractPdfText, looksLikePdf };

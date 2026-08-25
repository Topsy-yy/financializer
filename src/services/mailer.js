// EMAIL DELIVERY — SMTP, for sending a report to the people who need it.
//
// WHY THIS EXISTS. `channels: ["PDF", "CSV", "Email"]` used to be advertised by
// the executive-report endpoint while no mail implementation existed anywhere in
// the project. Rather than keep promising it, the claim was removed. This adds
// the capability for real, and the claim is re-advertised ONLY when the server
// is actually configured to send — an unconfigured deployment goes on saying it
// cannot, which is the same honesty rule the rest of this system follows.
//
// ─────────────────────────────────────────────────────────────────
// CREDENTIALS
// ─────────────────────────────────────────────────────────────────
// The password is read from the environment and never from a request, never
// from a database row, and never from a file this repository tracks. It is
// never logged, never echoed in an API response, and never included in an error
// message — `redactError()` below exists because SMTP libraries routinely put
// the failing credential into the exception they throw.
//
// For Gmail this must be an APP PASSWORD (a 16-character device password from
// the Google account's security settings), not the account password, and the
// account needs 2-step verification enabled. An app password can be revoked on
// its own without touching the account.
//
//   SMTP_HOST      smtp.gmail.com
//   SMTP_PORT      465 (implicit TLS) or 587 (STARTTLS)
//   SMTP_USER      the sending address
//   SMTP_PASSWORD  the app password
//   MAIL_FROM      what recipients see, e.g. "FinGuard AI <you@example.com>"
//
// ─────────────────────────────────────────────────────────────────
// WHAT THIS DELIBERATELY DOES NOT DO
// ─────────────────────────────────────────────────────────────────
// No marketing sends, no bulk delivery, no address lists. One report, to
// recipients the authenticated user names, on request. Financial data leaves
// the system the moment a report is emailed, so the route that calls this is
// rate-limited and the send is recorded.

const nodemailer = require("nodemailer");
const { logger } = require("./logger");

const log = logger.child({ component: "mailer" });

/** Transport is built once and reused; nodemailer pools connections. */
let transport = null;
let transportSignature = "";

function config() {
  return {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.MAIL_FROM || process.env.SMTP_USER || ""
  };
}

/**
 * Can this deployment send mail at all?
 *
 * Callers use this to decide whether to ADVERTISE email, so an unconfigured
 * server never offers a button that cannot work.
 */
function isConfigured() {
  const c = config();
  return Boolean(c.host && c.user && c.password);
}

/** What is missing, for an operator reading a startup warning. */
function missingConfig() {
  const c = config();
  return [
    !c.host && "SMTP_HOST",
    !c.user && "SMTP_USER",
    !c.password && "SMTP_PASSWORD"
  ].filter(Boolean);
}

function getTransport() {
  const c = config();
  /* Rebuild only when the configuration actually changes. The signature
     deliberately excludes the password — this string is held in memory for the
     process lifetime and there is no reason for the secret to be in it. */
  const signature = `${c.host}:${c.port}:${c.user}`;
  if (transport && signature === transportSignature) return transport;

  transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS. Never plaintext.
    secure: c.port === 465,
    requireTLS: c.port !== 465,
    auth: { user: c.user, pass: c.password },
    pool: true,
    maxConnections: 2
  });
  transportSignature = signature;
  return transport;
}

/**
 * Strip anything credential-shaped out of an SMTP error before it is logged or
 * returned.
 *
 * SMTP libraries and servers routinely include the username, and sometimes the
 * submitted password, in rejection messages. This project's logging contract
 * forbids credentials reaching a log line, and an API response must never carry
 * one back to a browser.
 */
function redactError(err) {
  const raw = String((err && err.message) || err || "unknown error");
  const c = config();
  let safe = raw;
  if (c.password) safe = safe.split(c.password).join("[redacted]");
  if (c.user) safe = safe.split(c.user).join("[sender]");
  // Anything that looks like an inline credential pair.
  safe = safe.replace(/\b(pass(word)?|pwd|auth)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return safe.slice(0, 300);
}

/** A plausible email address. Deliberately conservative. */
function isValidRecipient(value) {
  const v = String(value || "").trim();
  if (!v || v.length > 254) return false;
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(v);
}

/**
 * Send a report.
 *
 * @param {object} opts
 *   to          {string[]} recipients
 *   subject     {string}
 *   text        {string}   the report body, already rendered
 *   attachment  {{filename, content, contentType}} optional PDF
 * @returns {object} { ok, messageId } or { ok:false, reason, detail }
 */
async function sendReport({ to = [], subject, text, attachment = null } = {}) {
  if (!isConfigured()) {
    return {
      ok: false,
      reason: "mail_not_configured",
      detail: "Email delivery is not configured on this server. "
        + `Missing: ${missingConfig().join(", ")}.`
    };
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .map((r) => String(r || "").trim())
    .filter(Boolean);

  if (!recipients.length) {
    return { ok: false, reason: "no_recipient", detail: "No recipient address was given." };
  }
  const invalid = recipients.filter((r) => !isValidRecipient(r));
  if (invalid.length) {
    /* The addresses are echoed back because the USER typed them and needs to
       see which one to correct. They are not logged — see below. */
    return {
      ok: false, reason: "invalid_recipient",
      detail: `Not a valid email address: ${invalid.join(", ")}`
    };
  }
  /* A report carries the business's financial position. A send that fans out to
     an arbitrary list is a data-exfiltration path, so the count is bounded. */
  if (recipients.length > 5) {
    return {
      ok: false, reason: "too_many_recipients",
      detail: "A report can be sent to at most 5 recipients at a time."
    };
  }

  const c = config();
  try {
    const message = {
      from: c.from,
      to: recipients.join(", "),
      subject: subject || "Your FinGuard AI financial report",
      text: text || ""
    };
    if (attachment && attachment.content) {
      message.attachments = [{
        filename: attachment.filename || "report.pdf",
        content: attachment.content,
        contentType: attachment.contentType || "application/pdf"
      }];
    }

    const result = await getTransport().sendMail(message);

    /* WHAT IS LOGGED: that a send happened, how many recipients, whether it had
       an attachment. NOT the addresses (personal data), NOT the body (financial
       records), NOT the credentials. Consistent with the logging contract the
       rest of this system follows. */
    log.info("mail.sent", {
      recipients: recipients.length,
      hasAttachment: Boolean(attachment && attachment.content),
      messageId: result.messageId || null
    });

    return { ok: true, messageId: result.messageId || null, recipients: recipients.length };
  } catch (err) {
    const detail = redactError(err);
    log.error("mail.send_failed", { detail });
    return {
      ok: false,
      reason: "send_failed",
      // Redacted: an SMTP rejection can contain the submitted credential.
      detail
    };
  }
}

/**
 * Prove the credentials work, without sending anything.
 *
 * Lets an operator confirm setup — and lets a settings screen show whether
 * email is genuinely usable rather than merely configured.
 */
async function verify() {
  if (!isConfigured()) {
    return { ok: false, reason: "mail_not_configured", missing: missingConfig() };
  }
  try {
    await getTransport().verify();
    log.info("mail.verified", { host: config().host, port: config().port });
    return { ok: true, host: config().host, port: config().port };
  } catch (err) {
    const detail = redactError(err);
    log.error("mail.verify_failed", { detail });
    return { ok: false, reason: "verify_failed", detail };
  }
}

/** Test hook: drop the cached transport so config changes take effect. */
function reset() { transport = null; transportSignature = ""; }

module.exports = {
  sendReport, verify, isConfigured, missingConfig, isValidRecipient,
  redactError, reset
};

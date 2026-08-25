// EMAIL DELIVERY — configuration, validation, and credential safety.
//
// The riskiest thing about adding a mailer to this system is not whether mail
// arrives; it is that SMTP credentials and financial data both pass through it.
// SMTP servers routinely quote the submitted username, and sometimes the
// password, back in a rejection message — and that message is exactly what a
// naive implementation logs and returns to the browser.
//
// These tests never send mail. They pin the boundary behaviour: what is
// advertised, what is rejected, and what can leak.

const test = require("node:test");
const assert = require("node:assert/strict");

const mailer = require("../../src/services/mailer");

const APP_PASSWORD = "abcd efgh ijkl mnop";   // the shape Gmail issues
const SENDER = "reports@example.com";

function withSmtpEnv(overrides, fn) {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; });
  Object.assign(process.env, {
    SMTP_HOST: "smtp.example.com", SMTP_PORT: "587",
    SMTP_USER: SENDER, SMTP_PASSWORD: APP_PASSWORD,
    MAIL_FROM: `FinGuard <${SENDER}>`
  }, overrides);
  Object.entries(overrides).forEach(([k, v]) => { if (v === null) delete process.env[k]; });
  mailer.reset();

  /* RESTORE ONLY AFTER THE BODY HAS ACTUALLY FINISHED.
     A plain try/finally restores the environment synchronously, which for an
     ASYNC body happens while it is still suspended — so the callback ran with
     the real environment and every configured-state assertion saw an
     unconfigured mailer. Promises are awaited before restoring. */
  function restore() {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    mailer.reset();
  }

  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => { restore(); return value; },
      (err) => { restore(); throw err; }
    );
  }
  restore();
  return result;
}

// ── Configuration ────────────────────────────────────────────────

test("[M1] email is only 'configured' when it can actually send", () => {
  withSmtpEnv({}, () => {
    assert.equal(mailer.isConfigured(), true, "host + user + password is configured");
    assert.deepEqual(mailer.missingConfig(), []);
  });

  // Each missing piece is reported by name, so an operator can fix it.
  [["SMTP_HOST", null], ["SMTP_USER", null], ["SMTP_PASSWORD", null]].forEach(([key]) => {
    withSmtpEnv({ [key]: null }, () => {
      assert.equal(mailer.isConfigured(), false, `${key} missing means not configured`);
      assert.ok(mailer.missingConfig().includes(key), `${key} is named`);
    });
  });
});

test("[M2] an unconfigured server refuses to send rather than failing obscurely",
  async () => {
    await withSmtpEnv({ SMTP_PASSWORD: null }, async () => {
      const result = await mailer.sendReport({
        to: ["owner@example.com"], subject: "x", text: "y"
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "mail_not_configured");
      assert.match(result.detail, /SMTP_PASSWORD/,
        "and says exactly what is missing");
    });
  });

// ── Recipient validation ─────────────────────────────────────────

test("[M3] recipients are validated before anything is sent", async () => {
  await withSmtpEnv({}, async () => {
    const noRecipient = await mailer.sendReport({ to: [], subject: "x", text: "y" });
    assert.equal(noRecipient.reason, "no_recipient");

    const bad = await mailer.sendReport({
      to: ["owner@example.com", "not-an-address"], subject: "x", text: "y"
    });
    assert.equal(bad.reason, "invalid_recipient");
    assert.match(bad.detail, /not-an-address/,
      "the offending address is named so the user can correct it");
  });
});

test("[M4] a report cannot be fanned out to an arbitrary list", async () => {
  /* A report carries the business's financial position. An unbounded recipient
     list is a data-exfiltration path, not a convenience. */
  await withSmtpEnv({}, async () => {
    const many = Array.from({ length: 6 }, (_, i) => `person${i}@example.com`);
    const result = await mailer.sendReport({ to: many, subject: "x", text: "y" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too_many_recipients");
  });
});

test("[M5] address validation accepts real addresses and rejects injection shapes", () => {
  ["a@b.co", "first.last+tag@sub.example.com"].forEach((ok) =>
    assert.equal(mailer.isValidRecipient(ok), true, `${ok} is valid`));

  [
    "", "   ", "no-at-sign", "@example.com", "user@", "user@host",
    "a@b.co, evil@attacker.com",          // comma-separated smuggling
    "a@b.co;evil@attacker.com",           // semicolon smuggling
    "a@b.co\nBcc: evil@attacker.com",     // header injection
    `${"x".repeat(250)}@example.com`      // over-length
  ].forEach((bad) =>
    assert.equal(mailer.isValidRecipient(bad), false,
      `${JSON.stringify(bad)} is rejected`));
});

// ── THE ONE THAT MATTERS: credentials must not leak ──────────────

test("[M6] the app password never appears in an error", () => {
  withSmtpEnv({}, () => {
    /* A real Gmail rejection looks like this — it quotes the submitted
       credential straight back. Logging or returning it verbatim would put the
       app password in a log file and in a browser response. */
    const hostile = new Error(
      `535-5.7.8 Username and Password not accepted. user=${SENDER} `
      + `pass=${APP_PASSWORD} https://support.google.com/mail/?p=BadCredentials`);

    const safe = mailer.redactError(hostile);

    assert.equal(safe.includes(APP_PASSWORD), false,
      "THE POINT: the app password is not in the redacted message");
    assert.equal(safe.includes(SENDER), false,
      "nor is the sending account");
    assert.match(safe, /redacted/,
      "and the redaction is visible, so nobody thinks the field was empty");
  });
});

test("[M7] redaction also catches generic credential-shaped text", () => {
  withSmtpEnv({}, () => {
    ["password: hunter2", "pwd=s3cret", "auth: tok_abc123"].forEach((raw) => {
      const safe = mailer.redactError(new Error(raw));
      assert.match(safe, /\[redacted\]/, `${raw} is redacted`);
      assert.equal(/hunter2|s3cret|tok_abc123/.test(safe), false,
        `the secret in "${raw}" is gone`);
    });
  });
});

test("[M8] the transport cache key does not contain the password", () => {
  /* The signature is held for the process lifetime. There is no reason for the
     secret to be in a long-lived string. */
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/services/mailer.js"), "utf-8");
  const sig = src.slice(src.indexOf("const signature ="), src.indexOf("if (transport &&"));
  assert.equal(/password|pass\b/.test(sig), false,
    "the cache signature is built from host/port/user only");
});

test("[M9] nothing sensitive is logged on a successful send", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/services/mailer.js"), "utf-8");

  const logCall = src.slice(src.indexOf('log.info("mail.sent"'));
  const logBlock = logCall.slice(0, logCall.indexOf("});"));

  // A COUNT of recipients, not the addresses; no body, no credentials.
  assert.match(logBlock, /recipients: recipients\.length/,
    "the number of recipients is logged, not who they are");
  assert.equal(/recipients\.join|message\.text|c\.password/.test(logBlock), false,
    "addresses, body and credentials never reach a log line");
});

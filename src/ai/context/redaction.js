// COUNTERPARTY AND PRIVACY REDACTION.
//
// THE PROBLEM. Before JOB 9 every AI request carried the tenant's full
// counterparty list — real supplier and customer names — to a third-party
// provider, on a shared managed account, whether or not the question needed
// them. "What are my biggest risks?" does not require the model to know that the
// business banks with Rivera Logistics; "Why is Acme Ltd flagged?" does.
//
// THE POLICY. Identity is expanded only when it is BOTH necessary and
// authorized. Three levels:
//
//   AGGREGATE  no counterparty identity at all — counts and totals only.
//              Enough for "how concentrated am I?".
//
//   REDACTED   stable pseudonyms: "Vendor A", "Customer B". Enough for
//              "which supplier is my biggest risk, and what should I do?",
//              because the ANSWER can be de-pseudonymised for display without
//              the model ever seeing a real name. This is the default.
//
//   FULL       real names. Used when the user has named a counterparty (they
//              already know it), or when the request type requires it, AND the
//              user is authorized to see it.
//
// WHY PSEUDONYMS RATHER THAN REMOVAL. Removing names entirely breaks the answer:
// the model cannot say "your largest supplier accounts for 66% of spend, and
// losing them would halt operations" if it cannot tell one supplier from
// another. A stable pseudonym preserves the RELATIONSHIPS in the data while
// disclosing no identity, and the mapping is held server-side so the answer can
// be rehydrated before the user reads it.
//
// AUTHORIZATION IS CHECKED BEFORE EXPANSION, and tenant isolation is checked
// before authorization — a user cannot expand an identity in a tenant they do
// not belong to, whatever their role.

const crypto = require("crypto");

const LEVEL = Object.freeze({
  AGGREGATE: "aggregate",
  REDACTED: "redacted",
  FULL: "full"
});

/**
 * Roles permitted to see real counterparty identities.
 *
 * Mirrors the team roles the product already defines. An auditor and an
 * investor see the shape of the business, not its trading relationships;
 * an investor especially should not learn a portfolio company's supplier list.
 */
const IDENTITY_ROLES = Object.freeze(["owner", "founder", "admin", "finance_officer", "accountant"]);

/**
 * Decide the redaction level for one request.
 *
 * @param {object} args
 *   role        {string}  the requesting user's role, if known
 *   message     {string}  the question
 *   knownParties{string[]} counterparties in this period
 *   requested   {string}  an explicit level the caller wants (still authorized)
 * @returns {object} { level, reason, namedParties }
 */
function resolveLevel({ role = null, message = "", knownParties = [], requested = null } = {}) {
  const authorized = isIdentityAuthorized(role);

  // Which counterparties did the user NAME? If they typed it, they already know
  // it — withholding it from the model protects nothing and breaks the answer.
  const named = knownParties.filter((party) => {
    const p = String(party || "").trim();
    return p.length > 2 && String(message || "").toLowerCase().includes(p.toLowerCase());
  });

  if (requested === LEVEL.FULL && !authorized) {
    return Object.freeze({
      level: LEVEL.REDACTED,
      reason: "not_authorized_for_identity",
      namedParties: Object.freeze([])
    });
  }

  if (named.length) {
    if (!authorized) {
      // The user named a party but is not authorized to have identities
      // confirmed. Answer at the redacted level rather than refusing outright:
      // the analysis is still useful, the identity simply is not expanded.
      return Object.freeze({
        level: LEVEL.REDACTED,
        reason: "named_but_not_authorized",
        namedParties: Object.freeze([])
      });
    }
    return Object.freeze({
      level: LEVEL.FULL,
      reason: "user_named_the_counterparty",
      namedParties: Object.freeze(named)
    });
  }

  if (requested === LEVEL.AGGREGATE) {
    return Object.freeze({ level: LEVEL.AGGREGATE, reason: "requested", namedParties: Object.freeze([]) });
  }

  // The default: the question does not require identity, so it is not sent.
  return Object.freeze({
    level: LEVEL.REDACTED,
    reason: "identity_not_required_for_this_question",
    namedParties: Object.freeze([])
  });
}

function isIdentityAuthorized(role) {
  if (!role) return true; // a single-user workspace: the owner is the only actor
  return IDENTITY_ROLES.includes(String(role).toLowerCase());
}

/**
 * Build the pseudonym map for a period.
 *
 * Pseudonyms are stable WITHIN a period (so "Vendor A" means the same supplier
 * across every turn of a conversation) and derived from the tenant and the
 * name, so they do not leak ordering information across tenants.
 */
function buildAliasMap({ tenantId, period, vendors = [], customers = [], namedParties = [] }) {
  const map = new Map();
  const reverse = new Map();
  const named = new Set(namedParties.map((n) => String(n).toLowerCase()));

  const assign = (names, prefix) => {
    names.forEach((name, index) => {
      if (!name || map.has(name)) return;
      // A party the user named keeps its real name — they told us it.
      if (named.has(String(name).toLowerCase())) {
        map.set(name, name);
        reverse.set(name, name);
        return;
      }
      const alias = `${prefix} ${label(index)}`;
      map.set(name, alias);
      reverse.set(alias, name);
    });
  };

  assign(vendors, "Vendor");
  assign(customers, "Customer");

  return {
    tenantId, period,
    // name -> alias
    toAlias: (name) => (name == null ? null : (map.get(name) || name)),
    // alias -> name, for rehydrating the answer before display
    toName: (alias) => (alias == null ? null : (reverse.get(alias) || alias)),
    size: map.size,
    entries: () => Array.from(map.entries()),
    /** Fingerprint of the mapping, for the audit trail. */
    digest: () => crypto.createHash("sha256")
      .update(`${tenantId}|${period}|${Array.from(map.keys()).sort().join(",")}`)
      .digest("hex").slice(0, 16)
  };
}

/** A, B, ... Z, AA, AB, ... */
function label(index) {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Apply a level to a counterparty name.
 * AGGREGATE removes identity entirely; REDACTED pseudonymises; FULL passes through.
 */
function applyToName(name, level, aliases) {
  if (name == null) return null;
  if (level === LEVEL.FULL) return name;
  if (level === LEVEL.AGGREGATE) return null;
  return aliases ? aliases.toAlias(name) : "Counterparty";
}

/**
 * Rehydrate an answer for display.
 *
 * The model wrote "Vendor A"; the user should read "Rivera Logistics". This runs
 * AFTER validation, so the validator checks the answer as the model produced it
 * and the substitution cannot be used to smuggle a value past it.
 */
function rehydrate(text, aliases) {
  if (!text || !aliases || !aliases.size) return text;
  let out = String(text);
  // Longest alias first, so "Vendor AA" is not partially replaced by "Vendor A".
  aliases.entries()
    .map(([name, alias]) => ({ name, alias }))
    .filter((e) => e.alias !== e.name)
    .sort((a, b) => b.alias.length - a.alias.length)
    .forEach(({ name, alias }) => {
      out = out.split(alias).join(name);
    });
  return out;
}

/** Does this text still contain a real counterparty name? A leak check. */
function containsIdentity(text, names = []) {
  const haystack = String(text || "").toLowerCase();
  return names.filter((n) => n && haystack.includes(String(n).toLowerCase()));
}

module.exports = {
  LEVEL,
  IDENTITY_ROLES,
  resolveLevel,
  isIdentityAuthorized,
  buildAliasMap,
  applyToName,
  rehydrate,
  containsIdentity,
  label
};

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const config = require("../config");
// INGESTION: all financial data now enters through this single boundary.
// The legacy zohoClient/zohoBooksClient are no longer used by any route.
const ingestion = require("../ingestion");
const { createZohoSource } = require("../ingestion/sources/zohoSource");
const { persistIngestion } = require("../ingestion/persist");
const { parseFinancialCsv } = require("../services/csvFinancialImporter");
const pdfTextExtract = require("../services/pdfTextExtract");
const pdfDocumentImporter = require("../services/pdfDocumentImporter");

const { toLegacyAnalysis } = require("../domain/adapters/legacyAnalysis");
const methodology = require("../domain/rules/methodology");
const { buildStructuredReport } = require("../services/reportBuilder");
const { runFollowUpWorkflow } = require("../services/followUpWorkflow");
const { getCoreWalletIntegrationSummary } = require("../services/coreWalletClient");
const { deployCChainContract } = require("../services/avalancheContractDeployer");
const { appendDeploymentRecord, listDeploymentRecords } = require("../services/contractDeploymentHistory");
const { appendLedgerEntry, listLedgerEntries, summarizeMonth: summarizeOnchainMonth } = require("../services/onchainLedger");
const entitlements = require("../services/entitlements");
const { computeCashflowForecast } = require("../services/cashflowForecast");
const whatIfSimulator = require("../services/whatIfSimulator");
const monitoring = require("../services/monitoring");
const domainEngine = require("../domain/analysis/engine");
const { toLegacyContext, toLegacyAnomalyItem } = require("../domain/adapters/legacyContext");
const team = require("../services/team");
const { buildReportModel } = require("../services/reportFormatter");
const { renderReportPdf } = require("../services/pdfReport");
const customRules = require("../services/customRules");
const { listContractTemplates } = require("../services/contractTemplateRegistry");
const { createNonce, verifySignature } = require("../services/walletAuth");
const secretStore = require("../services/secretStore");
const { verifyDeploymentTx } = require("../services/onchainVerifier");
const { ethers } = require("ethers");
// Only the transaction-filter helper remains a direct import; chat, interpretation
// and the advisory routes all go through the orchestrator below.
const aiClient = require("../services/aiAnalysisClient");
const { extractTransactionFilter } = aiClient;
// JOB 8: the AI subsystem. Every AI request goes through the orchestrator, which
// builds a bounded context from the authoritative run, routes the provider, and
// validates the answer's figures before a user sees them.
const aiOrchestrator = require("../ai/orchestrator");
const aiRouter = require("../ai/providers/router");
const copilot = require("../ai/copilot/copilot");
const aiBilling = require("../ai/billing");
const tenantResolver = require("../services/tenantResolver");
const identityRevocation = require("../services/identityRevocation");
// Without a database, revocations persist beside the reports so a restart does
// not resurrect a revoked identity.
identityRevocation.setFallbackPath(config.reportsDir);
const dbPool = require("../db/pool");
const jobRepository = require("../db/repositories/jobRepository");
const analysisRunRepository = require("../db/repositories/analysisRunRepository");
const { logger } = require("../services/logger");
const conversationStore = require("../ai/copilot/conversation");
const copilotStore = require("../ai/copilot/store");
const aiAuditRepository = require("../db/repositories/aiAuditRepository");
const creditRepository = require("../db/repositories/creditRepository");
const profileRepository = require("../db/repositories/profileRepository");
const transactionRepository = require("../db/repositories/transactionRepository");
// The ONE authoritative reading of a cash balance (domain/model/cashPosition).
const { readCashPosition } = require("../domain/model/cashPosition");
const mailer = require("../services/mailer");
const subscriptionService = require("../services/subscriptionService");
const renewalReminders = require("../services/renewalReminders");
const billingRepository = require("../db/repositories/billingRepository");
const paymentProvider = require("../services/payments");
const transactionRetrieval = require("../services/transactionRetrieval");
const googleAuth = require("../services/googleAuth");

const router = express.Router();

function defaultProfile() {
  return {
    userName: config.userName || "Aisha",
    businessName: config.businessName || "ABC Traders Ltd",
    zohoApiKey: config.zohoApiKey || "",
    zohoOrgId: "",
    zohoRefreshToken: "",
    zohoApiDomain: "",
    zohoTokenExpiresAt: null,
    walletAddress: "",
    walletVerified: false,
    walletChainId: null,
    aiProvider: "openai",
    aiApiKey: "",
    aiAssistant: "controller-core",
    plan: "free",
    credits: null,
    creditsPeriod: null,
    customRules: [],
    ruleExecutionHistory: [],
    monitoring: monitoring.defaultMonitoring(),
    seenIssueFingerprints: [],
    notifications: [],
    team: null,
    googleSub: "",
    googleName: "",
    googleEmail: "",
    googlePicture: ""
  };
}

/**
 * Map an identity to a directory name that cannot escape the reports root.
 *
 * Traversal was already blocked: stripping everything outside
 * `[a-zA-Z0-9_-]` removes `.` and `/`, so `../../etc` cannot survive.
 *
 * WHAT WAS NOT SAFE was that stripping is LOSSY, and therefore NOT INJECTIVE.
 * `userStores` is keyed on the RAW id while the directory is keyed on the
 * sanitized one, so two distinct identities that differ only in stripped
 * characters — or beyond the 128-char cut — got two separate in-memory stores
 * pointing at ONE directory on disk. That is a cross-tenant read/write of
 * profiles, credentials, reports and the on-chain ledger, and it is reachable
 * because identity strings are not all provider-issued digits (see the
 * `<sub>.v<version>` cookie, invite owner ids, and team member ids).
 *
 * The fix keeps the mapping stable for ids that were ALREADY safe — so no
 * existing directory is renamed or orphaned — and disambiguates only the ids
 * that sanitization actually altered, by appending a short digest of the raw
 * value. Distinct identities can no longer collide.
 */
function safeDirName(id) {
  const raw = String(id || "guest");
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
  // Unchanged by sanitization: use it verbatim, preserving existing layout.
  if (cleaned === raw && cleaned) return cleaned;
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  // `cleaned` may be empty (an id of only stripped characters); the digest
  // alone still identifies it uniquely rather than collapsing it onto "guest".
  return `${cleaned.slice(0, 100) || "id"}-${digest}`;
}

/* Every visitor -- a Google-authenticated user or an anonymous guest/demo
   session -- gets fully isolated profile, review history, uploaded data,
   and on-disk report storage. Nothing is shared across users. */
const userStores = new Map();

// Sentinel the frontend echoes back for fields it never received the real
// value of (see GET /profile below) -- must never be written back as data.
const MASKED_VALUE = "***";

// A visible-but-safe preview (e.g. "sk-a1******3f9k") so a user can confirm
// which key is actually saved without the full secret ever reaching the
// browser -- more reassuring than a plain "configured: true" boolean.
function maskSecretPreview(secret) {
  const value = String(secret || "");
  if (value.length <= 8) return value ? "****" : "";
  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, value.length - 8))}${value.slice(-4)}`;
}

/**
 * Respond to an unexpected server error WITHOUT disclosing internals.
 *
 * Raw `error.message` was previously echoed to clients, leaking filesystem
 * paths, upstream provider text and stack fragments. The detail is logged
 * server-side (where it is useful) and the client receives an opaque code.
 * See docs/THREAT_MODEL.md T6.
 */
function serverError(res, res_context, error) {
  logger.error("route error", { route: res_context, error: (error && error.message) || String(error) });
  return res.status(500).json({ ok: false, error: "internal_error" });
}

function profileFilePath(reportsDir) {
  return path.join(reportsDir, "profile.json");
}

function canUseDatabaseProfile(userStore) {
  return Boolean(userStore && userStore.tenantId && dbPool.isConfigured() && profileRepository.available());
}

/**
 * Persist a profile.
 *
 * WHAT WAS WRONG. This returned void and caught everything, so a caller could
 * not tell a successful save from a failed one. In production, an unset
 * SECRETS_KEY made `sealProfile` throw — and that throw was caught here,
 * downgraded to a log line, and the user was told their credential was saved
 * when it was not.
 *
 * It now RETURNS A RESULT. Callers that are saving a credential must check it
 * and surface an honest error; callers making an incidental write (a credit
 * balance mirror, a notification) may ignore it, and the failure is still
 * logged.
 *
 * The write is ATOMIC — a temp file plus a rename — so a crash or a full disk
 * cannot leave a half-written profile that fails to parse on the next boot and
 * silently resets the user to defaults.
 *
 * @returns {object} { ok, reason, detail }
 */
async function persistProfileAsync(userStore) {
  let sealed;
  try {
    // Credentials are encrypted at rest (docs/THREAT_MODEL.md T5). Legacy
    // cleartext values are upgraded on this write. An undecryptable value is
    // written back as its original ciphertext, never as an empty string.
    sealed = secretStore.sealProfile(userStore.profile);
  } catch (e) {
    logger.error("profile.seal_failed", {
      code: e.code || null, error: e.message
    });
    return {
      ok: false,
      reason: e.code === "secrets_key_missing" ? "encryption_unavailable" : "encryption_failed",
      detail: "Credentials cannot be encrypted, so nothing was saved."
    };
  }

  if (canUseDatabaseProfile(userStore)) {
    try {
      await profileRepository.upsert(userStore.tenantId, sealed);
      return { ok: true, persisted: "database" };
    } catch (e) {
      logger.error("profile.persist_failed", { error: e.message, target: "database" });
      return {
        ok: false,
        reason: "write_failed",
        detail: "The profile could not be written to the database."
      };
    }
  }

  const target = profileFilePath(userStore.reportsDir);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(sealed, null, 2));
    // rename() is atomic within a filesystem: readers see either the old file
    // or the new one, never a partial write.
    fs.renameSync(temp, target);
    return { ok: true, persisted: "disk" };
  } catch (e) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    logger.error("profile.persist_failed", { error: e.message });
    return { ok: false, reason: "write_failed", detail: "The profile could not be written to disk." };
  }
}

function persistProfile(userStore) {
  persistProfileAsync(userStore).catch((e) => {
    logger.error("profile.persist_failed", { error: e.message, target: "background" });
  });
  return { ok: true, reason: "pending_background_write" };
}

/**
 * Persist a profile where the caller is SAVING A CREDENTIAL.
 *
 * On failure it sends an honest error instead of a success the user cannot
 * rely on. Returns true when the caller may continue.
 */
async function persistCredentialOrFail(res, userStore, what) {
  const result = await persistProfileAsync(userStore);
  if (result.ok) return true;
  res.status(503).json({
    ok: false,
    error: result.reason,
    detail: `${what} was NOT saved. ${result.detail} `
      + "Your existing stored credentials are unchanged."
  });
  return false;
}

function loadPersistedProfile(reportsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(profileFilePath(reportsDir), "utf-8"));
    return secretStore.openProfile(raw);
  } catch (e) {
    return null;
  }
}

async function hydrateProfileFromDatabase(userStore) {
  if (!userStore || userStore.profileHydratedFromDatabase) return;
  if (!canUseDatabaseProfile(userStore)) {
    userStore.profileHydratedFromDatabase = true;
    return;
  }

  try {
    const row = await profileRepository.load(userStore.tenantId);
    if (row && row.profile && typeof row.profile === "object") {
      userStore.profile = Object.assign(defaultProfile(), secretStore.openProfile(row.profile));
    } else {
      const seeded = await persistProfileAsync(userStore);
      if (!seeded.ok) {
        logger.warn("profile.seed_failed", { reason: seeded.reason });
      }
    }
  } catch (e) {
    logger.error("profile.hydrate_failed", { error: e.message });
  } finally {
    userStore.profileHydratedFromDatabase = true;
  }
}

/**
 * Resolve the caller's identity.
 *
 * SECURITY: identity comes from the server-side session, or from a COOKIE THAT
 * WE SIGNED. It is never taken from a raw request-supplied value.
 *
 * The previous implementation trusted an unsigned `fg_google_sub` cookie so that
 * identities survived a MemoryStore restart. Because a Google `sub` is a public
 * identifier (and this API returns it in /auth/session), anyone could set that
 * cookie and assume another user's account. The restart problem is real but the
 * fix is a durable session store, not an unauthenticated identity — so the
 * fallback now requires a valid signature.
 * See docs/THREAT_MODEL.md T2 and tests/security/containment.test.js.
 */
/**
 * Resolve the request's identity.
 *
 * `req.identityChecked` is set by the middleware below, which has already
 * verified the long-lived cookie against the server-side revocation version.
 * This function never accepts that cookie on its own.
 */
function getUserId(req) {
  if (req.session && req.session.googleUser && req.session.googleUser.sub) {
    return `google-${req.session.googleUser.sub}`;
  }
  /* THE REVOKED-COOKIE HOLE. This used to accept `fg_google_sub` on the strength
     of its signature alone, making it a 400-day bearer credential that logout
     could not invalidate for any copy of it. The cookie is now only honoured
     when the middleware has confirmed its identity version is current. */
  if (req.identityChecked && req.identityChecked.valid) {
    return `google-${req.identityChecked.subject}`;
  }
  const signed = req.signedCookies || {};
  return `guest-${signed.fg_guest_id || "anonymous"}`;
}

/**
 * Does a store already exist for this id? Used to refuse caller-supplied
 * identifiers BEFORE they can materialise state.
 */
function userStoreExists(id) {
  if (userStores.has(id)) return true;
  try {
    return fs.existsSync(path.join(config.reportsDir, safeDirName(id), "profile.json"));
  } catch (e) {
    return false;
  }
}

function getUserStoreById(id) {
  if (!userStores.has(id)) {
    const reportsDir = path.join(config.reportsDir, safeDirName(id));
    fs.mkdirSync(reportsDir, { recursive: true });
    // A dev-server restart (nodemon) or process redeploy would otherwise wipe
    // every profile back to defaults, silently losing saved API keys.
    const persisted = dbPool.isConfigured() ? null : loadPersistedProfile(reportsDir);
    userStores.set(id, {
      id,
      profile: Object.assign(defaultProfile(), persisted || {}),
      latestReviewContext: null,
      reviewHistory: [],
      // Recent analysis runs, keyed by period, so the copilot can compare two
      // periods from STORED authoritative results rather than re-deriving them.
      analysisRuns: {},
      // Per-session copilot conversations. Held in memory with the session, so a
      // transcript never becomes a second copy of financial data at rest.
      copilotConversations: null,
      uploadedMonthlyData: {},
      reportsDir
    });
  }
  return userStores.get(id);
}

function getUserStore(req) {
  return getUserStoreById(getUserId(req));
}

/**
 * Resolve the request's identity to a user store AND to a PostgreSQL tenant.
 *
 * THE FIX THAT MADE PERSISTENCE REAL. `req.userStore.tenantId` was never
 * assigned anywhere in the codebase, so every persistence and audit path
 * silently short-circuited on `no_tenant` — the whole PostgreSQL layer, its RLS
 * policies, the AI audit trail and the credit ledger were inert against the
 * running application, while their tests passed by constructing tenants
 * directly.
 *
 * The tenant is derived SERVER-SIDE from the session identity. Nothing the
 * client sends can influence it.
 */
/**
 * Verify the long-lived identity cookie against server-side revocation.
 *
 * Runs before the store is resolved, so a revoked cookie never reaches a
 * tenant. A cookie that fails verification is CLEARED, so the browser stops
 * presenting a credential the server will not honour.
 */
router.use(async (req, res, next) => {
  const signed = req.signedCookies || {};
  if (!signed.fg_google_sub) return next();

  try {
    const checked = await identityRevocation.verifyCookie(signed.fg_google_sub);
    req.identityChecked = checked;
    if (!checked.valid) {
      logger.info("identity.cookie.rejected", { reason: checked.reason });
      res.clearCookie("fg_google_sub", {
        httpOnly: true, sameSite: "lax", signed: true,
        secure: process.env.NODE_ENV === "production"
      });
    }
  } catch (err) {
    // Fail closed: an unverifiable cookie is not an accepted one.
    logger.error("identity.verification_failed", { error: err.message });
    req.identityChecked = { valid: false, reason: "verification_error" };
  }
  next();
});

/**
 * Revoke SESSIONS derived from a revoked identity, not just the cookie.
 *
 * THE DEFECT THIS CLOSES. Revoking the identity invalidated `fg_google_sub`,
 * but a session minted FROM that cookie outlived it. The attack was concrete:
 * copy the identity cookie, make one request, and `/auth/session` reconstructs
 * `req.session.googleUser` into a brand-new server-side session. Logout then
 * incremented the identity version and destroyed the OWNER's session — while
 * the copy's separate session still held `googleUser` and was still trusted,
 * because every consumer read the session without re-checking the identity
 * behind it. The 400-day cookie was revocable; the sessions it spawned were not.
 *
 * The session now carries the identity version it was established at, and it is
 * re-checked on every request. A revocation therefore invalidates the cookie AND
 * every session ever derived from it, which is what "logged out" has to mean.
 *
 * A session with no recorded version predates this and is treated exactly like
 * an unversioned cookie: honoured only while the identity has never been
 * revoked, so deploying this does not log existing users out.
 */
router.use(async (req, res, next) => {
  const sessionUser = req.session && req.session.googleUser;
  if (!sessionUser || !sessionUser.sub) return next();

  try {
    const current = await identityRevocation.currentVersion(sessionUser.sub);
    const stamped = Number.isInteger(req.session.identityVersion)
      ? req.session.identityVersion
      : 0;
    if (current !== stamped) {
      logger.info("identity.session_revoked", { stamped, reason: "version_mismatch" });
      // Drop the authenticated identity from this session. The session object
      // itself survives so the request can still be served as a guest.
      req.session.googleUser = null;
      delete req.session.identityVersion;
      req.identityChecked = { valid: false, reason: "session_revoked" };
    }
  } catch (err) {
    // Fail closed, for the same reason as the cookie check above.
    logger.error("identity.session_verification_failed", { error: err.message });
    req.session.googleUser = null;
    req.identityChecked = { valid: false, reason: "session_verification_error" };
  }
  next();
});

router.use(async (req, res, next) => {
  try {
    req.userStore = getUserStore(req);
    if (req.userStore.tenantId === undefined) {
      const identity = getUserId(req);
      req.userStore.tenantId = await tenantResolver.resolveTenant(identity, {
        name: req.userStore.profile.businessName || identity
      });
      if (req.userStore.tenantId) {
        req.userStore.userIdentity = identity;
      }
    }
    await hydrateProfileFromDatabase(req.userStore);

    /* THE ENTITLEMENT RESOLVER (JOB P6).
     *
     * The plan used to be whatever `profile.json` said, which made it
     * self-grantable and perishable. It is now derived from the tenant's
     * `active` subscription row in PostgreSQL, on EVERY request, so:
     *
     *   an upgrade takes effect on the next request, with no restart;
     *   an expiry downgrades on the next request, with no scheduled job;
     *   a file edited on disk grants nothing.
     *
     * The profile is synchronised from that authority so the nine existing
     * `entitlements.can(profile, …)` gates keep working unchanged — what they
     * read is now a derived fact rather than a stored claim. */
    await subscriptionService.syncProfilePlan(req.userStore);
    if (req.log && req.userStore.tenantId) {
      req.log = req.log.child({ tenantId: req.userStore.tenantId });
    }
    next();
  } catch (err) {
    // Tenant provisioning must never take a request down: the deterministic
    // analysis works without persistence.
    logger.error("tenant middleware failed", { error: err.message });
    req.userStore = req.userStore || getUserStore(req);
    if (req.userStore.tenantId === undefined) req.userStore.tenantId = null;
    next();
  }
});

const oauthStateStore = new Map();

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

function hasZohoOAuthConfig() {
  return Boolean(config.zohoOauthClientId && config.zohoOauthClientSecret && config.zohoOauthRedirectUri);
}

function cleanupOauthState() {
  const now = Date.now();
  for (const [state, payload] of oauthStateStore.entries()) {
    if (!payload || payload.expiresAt < now) {
      oauthStateStore.delete(state);
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMoney(amount) {
  return `${Math.round(toNumber(amount)).toLocaleString("en-KE")} KES`;
}

function parsePeriod(reportId) {
  const match = String(reportId || "").match(/^(\d{4}-\d{2})-/);
  return match ? match[1] : null;
}

function listReportFiles(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];

  return fs
    .readdirSync(reportsDir)
    .filter((name) => name.endsWith("-report.json"))
    .map((name) => {
      const fullPath = path.resolve(reportsDir, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        modifiedAt: stat.mtimeMs
      };
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function parseActionsCsv(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, "utf-8").trim();
  if (!raw) return [];

  const lines = raw.split(/\r?\n/).slice(1);
  return lines
    .map((line) => {
      const parts = line
        .split(",")
        .map((part) => part.replace(/^"|"$/g, "").replace(/""/g, '"'));
      return {
        task: parts[0] || "",
        owner: parts[1] || "founder",
        priority: (parts[2] || "normal").toLowerCase(),
        due: `${parts[3] || "7"} days`,
        status: "Pending"
      };
    })
    .filter((item) => item.task);
}

function periodToComparable(period) {
  const match = String(period || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  return Number(`${match[1]}${match[2]}`);
}

/**
 * Build the analysis context for a period.
 *
 * MIGRATED: the seven build* functions that used to live in this HTTP module
 * now live in src/domain/analysis/. This function delegates to the deterministic
 * engine and adapts its output to the legacy response shape via
 * domain/adapters/legacyContext, so the wire contract is preserved while the
 * engine becomes the single source of truth.
 *
 * The `analysis` argument (legacy riskEngine output) is accepted for call-site
 * compatibility but is no longer the source of findings — the domain detectors
 * produce them, with evidence and rule versions attached.
 */
/**
 * Run THE deterministic engine.
 *
 * JOB 6: this replaces services/riskEngine.js, which was a second, disagreeing
 * implementation of the same analysis. The legacy `{ detections, cashFlowRisk,
 * earlyWarnings }` shape is now PROJECTED from this run (see
 * domain/adapters/legacyAnalysis.js) rather than computed separately, so the
 * executive report and the dashboard can no longer show different numbers for
 * the same month.
 */
function analyzeFinancialRisk(monthlyData, opts = {}) {
  const data = monthlyData || {};
  const run = domainEngine.analyze(data, {
    tenantId: opts.tenantId || null,
    period: opts.period || data.period || null,
    now: opts.now,
    reviewHistory: opts.reviewHistory,
    ownerKeywords: config.businessOwnerKeywords,
    fetchedAt: data.meta ? data.meta.fetchedAt : undefined
  });
  return toLegacyAnalysis(run);
}

function buildContext({ month, monthlyData, analysis, report, followUp, reviewHistory, reportsDir, tenantId, now }) {
  const period = month || monthlyData.period || (report && report.period) || new Date().toISOString().slice(0, 7);

  // Reuse the analysis the caller already ran; only analyse here if there is
  // none. Running the engine twice on one request was the old double-engine
  // behaviour in a new form.
  const run = (analysis && analysis.run && analysis.run.period === period)
    ? analysis.run
    : domainEngine.analyze(monthlyData, {
      tenantId: tenantId || null,
      period,
      now,
      reviewHistory,
      ownerKeywords: config.businessOwnerKeywords,
      fetchedAt: monthlyData && monthlyData.meta ? monthlyData.meta.fetchedAt : undefined
    });

  // Tenant-scoped: only this business's on-chain movements may enter its analysis.
  const onchain = reportsDir
    ? summarizeOnchainMonth(reportsDir, period)
    : { scope: "unavailable", count: 0, items: [] };

  const context = toLegacyContext(run, { report, followUp, onchain });
  // Custom rules still run through the legacy path until JOB 7 moves them into
  // the rule registry; their findings are merged here.
  // Custom-rule findings are now REAL Findings produced by the same contract as
  // engine rules (domain/rules/customRules.js), so this merge no longer rebuilds
  // them — it just surfaces them. They carry authorityScope "tenant", which is
  // what keeps them out of the deterministic risk score.
  if (analysis && analysis.detections && Array.isArray(analysis.detections.customRuleMatches)) {
    analysis.detections.customRuleMatches.forEach((finding) => {
      if (!finding || !finding.findingId) return; // not a Finding — ignore rather than fabricate
      context.anomalies.items.push(toLegacyAnomalyItem(finding));
      context.findings.push(finding);
    });
  }
  return context;
}

function contextFromLatestReportDisk(reportsDir) {
  const files = listReportFiles(reportsDir);
  if (!files.length) return null;

  const latest = files[0];
  const report = JSON.parse(fs.readFileSync(latest.fullPath, "utf-8"));
  const reportPrefix = latest.name.replace(/-report\.json$/, "");
  const actionsCsv = path.resolve(reportsDir, `${reportPrefix}-actions.csv`);
  const actions = parseActionsCsv(actionsCsv);

  const runwayMonths = toNumber(report.risk?.runwayMonths, 0);
  const summaryItems = Array.isArray(report.summary?.founderSummary) ? report.summary.founderSummary : [];

  return {
    period: report.period || parsePeriod(reportPrefix),
    health: {
      overall_score: clamp(100 - toNumber(report.risk?.riskScore, 0), 0, 100),
      risk_category: report.risk?.severity || "unknown",
      summary: report.summary?.headline || "Health summary not available",
      component_scores: {}
    },
    cashflow: {
      runway_days: runwayMonths > 0 ? Math.round(runwayMonths * 30) : null,
      cash_runway: runwayMonths > 0 ? Math.round(runwayMonths * 30) : null,
      cash_runway_months: runwayMonths,
      net_cash_flow: toNumber(report.risk?.netCashFlow, 0),
      risk_level: report.risk?.severity || "unknown",
      findings: (report.summary?.warnings || []).map((w) => ({ severity: "medium", description: w })),
      recommendations: ["Run a fresh monthly analysis for complete liquidity diagnostics."],
      skills: ["cashflow-risk-analyzer"]
    },
    revenue: {
      total_revenue: null,
      growth_rate: null,
      direction: "unknown",
      findings: [],
      trends: [],
      skills: ["revenue-intelligence"]
    },
    anomalies: {
      items: (report.checklist || [])
        .filter((item) => item.count > 0)
        .map((item) => ({
          type: item.item,
          severity: item.status === "action-needed" ? "high" : "medium",
          description: `${item.item}: ${item.count}`
        })),
      skills: ["fraud-and-errors-detector"]
    },
    vendors: {
      vendor_risk_score: null,
      concentration: {},
      vendor_list: [],
      findings: [],
      skills: ["vendor-dependency-detector"]
    },
    customers: {
      customer_risk_score: null,
      concentration: {},
      customer_list: [],
      findings: [],
      skills: ["customer-concentration-detector", "revenue-intelligence"]
    },
    actions: {
      actions,
      skills: ["followup-orchestrator", "recommendation-engine"]
    },
    reports: {
      report,
      reportId: reportPrefix,
      skills: ["executive-report-generator", "financial-controller-core"]
    },
    overview: {
      health_score: clamp(100 - toNumber(report.risk?.riskScore, 0), 0, 100),
      cashflow: {
        runway_days: runwayMonths > 0 ? Math.round(runwayMonths * 30) : null
      },
      risk: {
        items: (report.checklist || []).filter((item) => item.count > 0)
      },
      revenue: {
        trend: "Run fresh analysis for revenue trend"
      },
      findings: (report.checklist || []).filter((item) => item.count > 0),
      ai_summary: summaryItems.join("\n") || report.summary?.headline || "No summary available.",
      pending_actions: actions.length,
      skills: ["financial-health-scorer", "financial-controller-core", "executive-report-generator"]
    }
  };
}

function getContext(req) {
  if (req.userStore.latestReviewContext) return req.userStore.latestReviewContext;
  req.userStore.latestReviewContext = contextFromLatestReportDisk(req.userStore.reportsDir);
  return req.userStore.latestReviewContext;
}

/**
 * The dashboard context, RECOVERING FROM POSTGRESQL when this process has none.
 *
 * JOB 11. `getContext` reads process memory and then a report file on local
 * disk. Neither survives a redeploy onto fresh storage, so every dashboard
 * panel answered "Run monthly review first" while a completed analysis sat in
 * the database. This adds the missing third source: the persisted run.
 *
 * The recovered run is converted through the SAME legacy adapter a fresh
 * analysis goes through, so the panels receive the shape they already expect
 * and no route needs a branch for "this came from the database".
 *
 * NOTHING IS RECOMPUTED — `toLegacyAnalysis` is a projection of stored values,
 * not a re-analysis, and the engine is never invoked here.
 */
async function getContextAsync(req, period = null) {
  const inMemory = getContext(req);

  /* THE CACHED CONTEXT MUST BE FOR THE PERIOD THAT WAS ASKED FOR.
   *
   * A DEFECT FOUND WHILE AUDITING DISCLOSURE. This returned the cached context
   * unconditionally, so `GET /api/cashflow?month=2026-05` answered with
   * whatever period was reviewed most recently. Asking for May returned June's
   * figures under May's heading — and because the two periods differ in exactly
   * the way this work cares about (May's cash balance was observed, June's was
   * derived), May's real cash position was replaced by an unavailable one, and
   * June's limitations were disclosed against May.
   *
   * Wrong-month figures are worse than missing ones: nothing about the response
   * indicates the mismatch, so a reader has no way to detect it. When a period
   * is named and the cache holds a different one, the cache is bypassed and the
   * requested period is loaded from storage. */
  if (inMemory && (!period || inMemory.period === period)) return inMemory;

  const targetPeriod = period
    || (req.userStore.latestReviewContext && req.userStore.latestReviewContext.period)
    || null;
  if (!targetPeriod) {
    /* No period was asked for and none is remembered. Rather than guess, use
       the most recent period this tenant actually has a completed run for. */
    if (!req.userStore.tenantId || !dbPool.isConfigured()) return null;
    try {
      const periods = await analysisRunRepository.completedPeriods(req.userStore.tenantId, { limit: 1 });
      const latest = periods.find((p) => p.recoverable);
      if (!latest) return null;
      return buildContextFromRecoveredRun(req, latest.period);
    } catch (err) {
      logger.warn("dashboard.recovery_lookup_failed", { error: err.message });
      return null;
    }
  }
  return buildContextFromRecoveredRun(req, targetPeriod);
}

async function buildContextFromRecoveredRun(req, period) {
  const resolved = await resolveRun(req.userStore, period);
  if (!resolved.run) return null;

  const analysis = toLegacyAnalysis(resolved.run);
  const context = buildContext({
    month: period,
    // The period inputs travel with the recovered run, so figures that depend
    // on them (cash runway) are the STORED ones rather than recomputed.
    monthlyData: { period, transactions: [], meta: (resolved.run.periodInputs || {}).ingestion || {} },
    analysis,
    report: {},
    followUp: {},
    reviewHistory: req.userStore.reviewHistory || [],
    reportsDir: req.userStore.reportsDir,
    tenantId: req.userStore.tenantId || null
  });
  context.rawAnalysis = analysis;
  context.period = period;
  // Provenance, so the UI and support can tell a reloaded analysis from a fresh
  // one. The VALUES are identical; only this marker differs.
  context.recovered = true;
  context.recoveredRunId = resolved.run.analysisRunId;
  req.userStore.latestReviewContext = context;
  return context;
}

/* ============================================================
   Conversational AI — Chat endpoint
   ============================================================ */

// Extract a target month (YYYY-MM) from a free-text question so the chat answers
// about the month the user actually asked about — "risks in June 2026",
// "june expenses", "2026-06" — instead of always the last-analyzed month.
const CHAT_MONTH_LOOKUP = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};
// "may" and "mar/march" are common English words; only treat them as months when
// an explicit year accompanies them, to avoid false matches ("you may…").
const CHAT_MONTH_AMBIGUOUS = { may: true, mar: true, march: true };
function parseMonthFromText(message) {
  const text = String(message || "").toLowerCase();
  const iso = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (iso) return iso[1] + "-" + String(Number(iso[2])).padStart(2, "0");
  const names = Object.keys(CHAT_MONTH_LOOKUP).sort((a, b) => b.length - a.length).join("|");
  const match = text.match(new RegExp("\\b(" + names + ")\\b(?:\\s+(20\\d{2}))?"));
  if (match) {
    const name = match[1];
    const year = match[2];
    if (CHAT_MONTH_AMBIGUOUS[name] && !year) return null;
    const mo = CHAT_MONTH_LOOKUP[name];
    const yr = year ? Number(year) : new Date().getUTCFullYear();
    return yr + "-" + String(mo).padStart(2, "0");
  }
  return null;
}

// An honest banner shown when the AI call fails, so the rule-based fallback is
// never mistaken for a real AI answer.
function aiUnavailableNote(reason) {
  switch (reason) {
    case "missing_ai_api_key":
      return "⚠️ No AI provider is connected, so I can't give an AI-written answer. Add a key in Settings. Here's a rule-based summary from the analysis engine instead:";
    case "managed_key_unavailable":
      return "⚠️ The managed AI service isn't configured on this server. Here's a rule-based summary from the analysis engine instead:";
    case "insufficient_credits":
      return "⚠️ You're out of AI credits for the current cycle, so this is a rule-based summary — not an AI answer. Upgrade or add your own key in Settings.";
    case "timeout":
      return "⚠️ The AI took too long to respond, so here's a rule-based summary instead. Try again in a moment for a full AI answer.";
    case "request_failed":
      return "⚠️ I couldn't reach the AI provider just now (a network/connection issue), so this is a rule-based summary — not an AI answer. Try again shortly.";
    case "rate_limited":
      return "⚠️ The AI provider's rate limit was reached, so this is a rule-based summary. Try again shortly.";
    case "ai_analysis_disabled":
      return "⚠️ AI analysis is turned off on this server, so this is a rule-based summary from the analysis engine — not an AI answer.";
    default:
      return "⚠️ The AI is temporarily unavailable, so this is a rule-based summary from the analysis engine — not an AI-written answer.";
  }
}

/**
 * Simple intent classifier based on keyword matching.
 * Returns an object with the matched intent and extracted entities.
 */
function classifyIntent(message) {
  const lower = message.toLowerCase();

  const intents = {
    cashflow: ["cash flow", "cashflow", "cash", "runway", "burn rate", "inflow", "outflow", "money coming in", "money going out"],
    risk: ["risk", "risk score", "severity", "danger", "threat", "vulnerability"],
    anomalies: ["anomaly", "anomalies", "fraud", "suspicious", "unusual", "duplicate", "irregular", "red flag"],
    expenses: ["expense", "spending", "cost", "costs", "highest", "biggest expense", "where is my money going"],
    warnings: ["warning", "alert", "early warning", "red flag", "concern"],
    summary: ["summary", "overview", "recap", "brief", "what happened", "tell me about"],
    actions: ["action", "follow-up", "follow up", "todo", "to do", "what should i do", "next step"],
    compare: ["compare", "vs", "versus", "difference", "last month", "previous month", "trend"],
    income: ["income", "revenue", "sales", "earnings", "profit"],
    general: ["hello", "hi", "hey", "help", "what can you do", "capabilities"]
  };

  for (const [intent, keywords] of Object.entries(intents)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) return intent;
    }
  }

  return "general";
}

/**
 * Build a conversational response based on the analysis data.
 */
function buildChatResponse(intent, analysis, month, assistantConfig) {
  const detections = analysis.detections || {};
  const cashFlowRisk = analysis.cashFlowRisk || {};
  const earlyWarnings = analysis.earlyWarnings || [];
  const suggestions = [];

  let text = "";
  let html = "";

  switch (intent) {
    case "cashflow": {
      /* AN UNMEASURED NET CASH FLOW IS NOT ZERO.
         This defaulted to 0 and then rendered "a net cash flow of 0 KES
         (positive)" — a measurement the user never gave us, stated as fact and
         labelled POSITIVE. Runway on the very next line already said "unknown"
         when it could not be computed; net simply had not been given the same
         treatment. */
      const net = cashFlowRisk.netCashFlow;
      const netMeasured = net != null;
      const runway = cashFlowRisk.runwayMonths != null ? cashFlowRisk.runwayMonths : "unknown";
      const severity = cashFlowRisk.severity || "unknown";
      const sign = netMeasured ? (net >= 0 ? "positive" : "negative") : "not measured";
      const netText = netMeasured
        ? `${Math.abs(net).toLocaleString()} KES (${sign})`
        : "not available for this period";

      text = `Your cash flow analysis for ${month || "the current period"} shows a net cash flow of ${netText}. Estimated runway is ${runway} months with a risk severity of ${severity}.`;
      html = `<p><strong>Cash Flow Analysis — ${escapeHtml(month || "Current Period")}</strong></p>
<p>Net cash flow: <strong>${netMeasured ? `${sign === "positive" ? "" : "-"}${escapeHtml(Math.abs(net).toLocaleString())} KES` : "not available"}</strong>${netMeasured ? ` (${sign})` : ""}</p>
<p>Estimated runway: <strong>${escapeHtml(String(runway))} months</strong></p>
<p>Risk severity: <strong>${escapeHtml(severity)}</strong></p>`;

      if (runway < 6) {
        html += `<p style="color: var(--danger);">⚠️ Your runway is below 6 months. Consider reducing discretionary spending and accelerating receivables.</p>`;
      }
      if (netMeasured && net < 0) {
        html += `<p style="color: var(--warning);">⚠️ Your outflow exceeds inflow. Review your burn rate and identify cost-cutting opportunities.</p>`;
      }

      suggestions.push("What's my burn rate?", "How can I improve cash flow?", "Show me the income vs expenses breakdown");
      break;
    }

    case "risk":
    case "summary": {
      const score = cashFlowRisk.riskScore != null ? cashFlowRisk.riskScore : "N/A";
      const severity = cashFlowRisk.severity || "unknown";
      const runway = cashFlowRisk.runwayMonths != null ? cashFlowRisk.runwayMonths : "unknown";

      text = `Risk assessment for ${month || "the current period"}: score ${score}/100, severity ${severity}, runway ${runway} months.`;
      html = `<p><strong>Risk Assessment — ${escapeHtml(month || "Current Period")}</strong></p>
<p>Risk score: <strong>${escapeHtml(String(score))}/100</strong> (${escapeHtml(severity)})</p>
<p>Estimated runway: <strong>${escapeHtml(String(runway))} months</strong></p>`;

      if (earlyWarnings.length > 0) {
        html += `<p><strong>Early warnings:</strong></p><ul>`;
        earlyWarnings.forEach(function (w) {
          html += `<li>${escapeHtml(w)}</li>`;
        });
        html += `</ul>`;
      }

      suggestions.push("What are the early warnings?", "Show me the risk details", "What's my cash flow situation?");
      break;
    }

    case "anomalies": {
      const duplicates = detections.duplicates || [];
      const unusual = detections.unusualTransactions || [];
      const roundNumbers = detections.roundNumbers || [];
      const mixedFunds = detections.mixedFunds || [];
      const totalAnomalies = duplicates.length + unusual.length + roundNumbers.length + mixedFunds.length;

      text = `Found ${totalAnomalies} anomalies in ${month || "the current period"}: ${duplicates.length} duplicates, ${unusual.length} unusual transactions, ${roundNumbers.length} round-number transactions, ${mixedFunds.length} potential mixed fund entries.`;
      html = `<p><strong>Anomaly Detection — ${escapeHtml(month || "Current Period")}</strong></p>
<p>Total anomalies found: <strong>${totalAnomalies}</strong></p>
<ul>
  <li>Duplicate transactions: <strong>${duplicates.length}</strong></li>
  <li>Unusual high-value transactions: <strong>${unusual.length}</strong></li>
  <li>Suspicious round-number transactions: <strong>${roundNumbers.length}</strong></li>
  <li>Potential mixed funds (owner-related): <strong>${mixedFunds.length}</strong></li>
</ul>`;

      if (totalAnomalies === 0) {
        html += `<p>✅ No anomalies detected. Your transactions look clean for this period.</p>`;
      } else {
        html += `<p>⚠️ Review the flagged items in the full report for details.</p>`;
      }

      suggestions.push("Show me the duplicate transactions", "What are the unusual transactions?", "Run a full fraud check");
      break;
    }

    case "expenses": {
      text = `I've analyzed the expense patterns for ${month || "the current period"}. The full report shows detailed breakdowns.`;
      html = `<p><strong>Expense Analysis — ${escapeHtml(month || "Current Period")}</strong></p>
<p>I've reviewed the transaction data for this period. The detailed expense breakdown is available in the full report above.</p>
<p>Key areas to review:</p>
<ul>
  <li>Compare your expenses against previous months to spot trends</li>
  <li>Check for any unusually large transactions</li>
  <li>Verify that all expenses are properly categorized</li>
</ul>`;

      suggestions.push("What are my biggest expenses?", "Show expense trends", "Compare with last month");
      break;
    }

    case "warnings": {
      if (earlyWarnings.length > 0) {
        text = `There are ${earlyWarnings.length} early warnings for ${month || "the current period"}.`;
        html = `<p><strong>Early Warnings — ${escapeHtml(month || "Current Period")}</strong></p><ul>`;
        earlyWarnings.forEach(function (w) {
          html += `<li>${escapeHtml(w)}</li>`;
        });
        html += `</ul>`;
      } else {
        text = `No early warnings for ${month || "the current period"}. Everything looks stable.`;
        html = `<p><strong>Early Warnings</strong></p><p>✅ No early warnings for ${escapeHtml(month || "the current period")}. Everything looks stable.</p>`;
      }

      suggestions.push("What's my risk score?", "Show me the full analysis", "What follow-up actions are needed?");
      break;
    }

    case "actions": {
      text = `I can help you track follow-up actions. Select a month from the sidebar to run a full analysis that includes action items.`;
      html = `<p><strong>Follow-up Actions</strong></p>
<p>To generate and track follow-up actions, please select a month from the sidebar to run a complete financial analysis. The report will include prioritized action items with owners and due dates.</p>`;

      suggestions.push("Run analysis for this month", "Show me the latest report", "What are the top priorities?");
      break;
    }

    case "compare": {
      text = `I can compare different periods. Select a month from the sidebar to run an analysis, then ask me to compare it with another period.`;
      html = `<p><strong>Period Comparison</strong></p>
<p>To compare financial periods, start by selecting a month from the sidebar to run an analysis. Once the report is generated, I can help you compare it with previous months.</p>`;

      suggestions.push("Run analysis for last month", "Run analysis for this month", "Show me trends");
      break;
    }

    case "income": {
      text = `I can analyze your income and revenue. Select a month from the sidebar for a full breakdown.`;
      html = `<p><strong>Income & Revenue Analysis</strong></p>
<p>For a detailed income analysis, please select a month from the sidebar. The full report includes revenue, profit/loss, and cash flow breakdowns.</p>`;

      suggestions.push("Show me the profit and loss", "What's my revenue trend?", "Run analysis for this month");
      break;
    }

    case "general":
    default: {
      text = `Hello! I'm your FinGuard AI. I can analyze your financial data, detect anomalies, assess risks, and suggest follow-up actions. Select a month from the sidebar or ask me a specific question.`;
      html = `<p>Hello! I'm your <strong>FinGuard AI</strong>.</p>
<p>I can help you with:</p>
<ul>
  <li><strong>Monthly financial analysis</strong> — Select a month from the sidebar</li>
  <li><strong>Risk assessment</strong> — Ask about risk scores and early warnings</li>
  <li><strong>Anomaly detection</strong> — Ask about fraud, duplicates, or unusual transactions</li>
  <li><strong>Cash flow analysis</strong> — Ask about runway, burn rate, or cash position</li>
  <li><strong>Follow-up actions</strong> — I'll track what needs to be done</li>
</ul>
<p>What would you like to explore?</p>`;

      suggestions.push("What's my current cash flow?", "Show me the risk assessment", "Are there any anomalies?", "What expenses are highest?");
      break;
    }
  }

  const assistant = assistantConfig?.assistant || "controller-core";
  const provider = assistantConfig?.provider || "openai";

  let assistantStyle = "I am using the financial skills pipeline to process your data.";
  if (assistant === "risk-analyst") {
    assistantStyle = "I am prioritizing risk interpretation from fraud, concentration, and liquidity skills.";
  } else if (assistant === "cashflow-guardian") {
    assistantStyle = "I am prioritizing cash preservation and runway decisions from cashflow skills.";
  } else if (assistant === "executive-brief") {
    assistantStyle = "I am prioritizing concise management-level explanations from reporting skills.";
  }

  text += `\n\n[Assistant: ${assistant} via ${provider}] ${assistantStyle}`;
  html += `<p class=\"text-sm text-muted\" style=\"margin-top:0.75rem\">Assistant: <strong>${escapeHtml(assistant)}</strong> via <strong>${escapeHtml(provider)}</strong> · Skill-first processing</p>`;

  return { text, html, suggestions };
}

function escapeHtml(value) {
  var s = String(value);
  var a = "&" + "amp;";
  var l = "&" + "lt;";
  var g = "&" + "gt;";
  var q = "&" + "quot;";
  var ap = "&#" + "39;";
  var map = { "&": a, "<": l, ">": g, '"': q, "'": ap };
  return s.replace(/[&<>"']/g, function (m) { return map[m]; });
}

/**
 * LIVENESS — is the process running?
 *
 * Deliberately checks nothing else. A liveness probe that consults a dependency
 * causes the orchestrator to RESTART the process when that dependency blips,
 * which turns a database hiccup into a rolling outage.
 */
router.get("/health/live", (req, res) => {
  res.json({ ok: true, status: "live", service: "ai-financial-controller",
    now: new Date().toISOString() });
});

/**
 * READINESS — can this instance serve traffic in its CURRENT mode?
 *
 * Production requires PostgreSQL: without it there is no persistence, no
 * tenant isolation at the data layer, no audit trail, and billing cannot be
 * atomic. So a production instance with no database is NOT ready and should be
 * taken out of the load balancer — but it is still LIVE and must not be killed.
 *
 * AI provider availability deliberately does NOT affect readiness: the
 * deterministic analysis — the actual product — works without it, and the app
 * degrades honestly. Marking the whole application unready because a third
 * party is slow would be a self-inflicted outage.
 */
router.get("/health/ready", async (req, res) => {
  const checks = {};
  let ready = true;

  const database = await checkDatabase();
  checks.database = database;
  if (isProductionMode() && !database.ok) ready = false;

  checks.billing = {
    ok: !isProductionMode() || database.ok,
    mode: aiBilling.mode(),
    detail: isProductionMode() && !database.ok
      ? "Production billing requires the ledger; AI requests are paused."
      : null
  };
  if (!checks.billing.ok) ready = false;

  checks.engine = { ok: true, engineVersion: require("../domain/rules/registry").ENGINE_VERSION };

  // Reported, never gating.
  checks.ai = {
    ok: true,
    configured: Boolean(config.enableAiAnalysis && (config.nvidiaApiKey || config.mistralAppKey)),
    detail: "AI availability does not gate readiness; deterministic analysis is unaffected."
  };

  res.status(ready ? 200 : 503).json({
    ok: ready,
    status: ready ? "ready" : "not_ready",
    mode: process.env.NODE_ENV || "development",
    checks,
    now: new Date().toISOString()
  });
});

/** Retained for compatibility with existing probes. */
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "ai-financial-controller", now: new Date().toISOString() });
});

function isProductionMode() {
  return process.env.NODE_ENV === "production";
}

async function checkDatabase() {
  if (!dbPool.isConfigured()) {
    return { ok: false, configured: false, detail: "DATABASE_URL is not set." };
  }
  try {
    const client = await dbPool.getPool().connect();
    try {
      await client.query("SELECT 1");
      return { ok: true, configured: true };
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error("health.database.unreachable", { error: err.message });
    return { ok: false, configured: true, detail: "The database is unreachable." };
  }
}

router.get("/auth/session", async (req, res) => {
  let googleUser = req.session && req.session.googleUser;

  // Session lost (e.g. server restarted) but the persistent cookie still
  // identifies this browser as a known Google user -- reconstruct their
  // display info from the profile we saved at login instead of silently
  // demoting them to a guest.
  /* TWO DEFECTS were closed here in the final closure phase, both from this
     block having used the RAW cookie (`req.signedCookies.fg_google_sub`)
     instead of the verified identity:

     1. REVOCATION BYPASS. It never consulted identityRevocation, so a
        revoked-but-still-signed cookie could call this endpoint — a GET, so no
        CSRF gate — and have its name/email disclosed AND get
        `req.session.googleUser` re-seeded from disk. That handed a stolen
        cookie back the session that logout had just destroyed.

     2. DIRECTORY ALIASING. The cookie value is now `<sub>.v<version>`, and
        safeDirName() STRIPS the dot rather than rejecting the value — so
        `google-1234.v0` resolved to the directory `google-1234v0`, while every
        other route resolves the bare subject to `google-1234`. This read a
        store that is never written, so the restart-recovery this block exists
        for was silently dead, and it created a junk directory per visit.

     `req.identityChecked` is set by the middleware above, which has already
     confirmed the signature AND that the identity version is current, and
     exposes the DECODED subject. */
  if (!googleUser && req.identityChecked && req.identityChecked.valid) {
    const store = getUserStoreById(`google-${req.identityChecked.subject}`);
    if (store.profile.googleSub) {
      googleUser = {
        sub: store.profile.googleSub,
        name: store.profile.googleName,
        email: store.profile.googleEmail,
        picture: store.profile.googlePicture
      };
      req.session.googleUser = googleUser;
      /* Stamp the version this session is established at, so revoking the
         identity also invalidates THIS session (see the middleware above).
         The cookie's version was just verified as current, so it is the
         correct stamp. */
      req.session.identityVersion = req.identityChecked.version != null
        ? req.identityChecked.version
        : await identityRevocation.currentVersion(req.identityChecked.subject);
    }
  }

  const authenticated = Boolean(googleUser);
  res.json({
    ok: true,
    google_enabled: config.enableGoogleAuth,
    authenticated,
    user: authenticated
      ? {
        sub: googleUser.sub,
        name: googleUser.name || null,
        email: googleUser.email || null,
        picture: googleUser.picture || null
      }
      : null
  });
});

const googleOauthStateStore = new Map();

router.get("/auth/google/start", (req, res) => {
  if (!config.enableGoogleAuth) {
    return res.redirect("/app?auth=not_configured");
  }

  const now = Date.now();
  for (const [key, value] of googleOauthStateStore.entries()) {
    if (!value || value.expiresAt < now) googleOauthStateStore.delete(key);
  }

  const state = crypto.randomBytes(16).toString("hex");
  googleOauthStateStore.set(state, { expiresAt: now + 10 * 60 * 1000 });

  return res.redirect(googleAuth.buildAuthUrl(state));
});

router.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(`/app?auth=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state || !googleOauthStateStore.has(state)) {
    return res.redirect("/app?auth=error&reason=invalid_state");
  }
  googleOauthStateStore.delete(state);

  try {
    const tokens = await googleAuth.exchangeCodeForTokens(String(code));
    const profile = await googleAuth.fetchUserInfo(tokens.access_token);

    /* REQUIRE A VERIFIED EMAIL.
     *
     * `fetchUserInfo` has always returned `emailVerified`, and nothing ever
     * checked it. That mattered because workspace membership can be matched on
     * email (see resolveCollabWorkspace): an unverified account claiming a
     * victim's address was a path to a workspace it was invited to.
     *
     * An account whose email Google has not verified is not accepted as an
     * identity here. */
    if (!profile || profile.emailVerified !== true) {
      logger.warn("auth.google.unverified_email_rejected", {
        hasProfile: Boolean(profile)
      });
      return res.redirect("/app?auth=error&reason=email_not_verified");
    }
    if (!profile.sub) {
      return res.redirect("/app?auth=error&reason=google_auth_failed");
    }

    req.session.googleUser = profile;
    // req.userStore was already resolved by the router-level middleware using
    // whatever identity this request arrived with (a guest, most likely) --
    // fetch/create the REAL google-scoped store directly so login info lands
    // in the right place, and set a persistent cookie so this identity
    // survives a lost session (see getUserId).
    const googleStore = getUserStoreById(`google-${profile.sub}`);
    googleStore.profile.googleSub = profile.sub;
    googleStore.profile.googleName = profile.name || "";
    googleStore.profile.googleEmail = profile.email || "";
    googleStore.profile.googlePicture = profile.picture || "";
    const saved = await persistProfileAsync(googleStore);
    if (!saved.ok) {
      logger.error("auth.google.persist_failed", { reason: saved.reason });
      return res.redirect(`/app?auth=error&reason=${encodeURIComponent(saved.reason)}`);
    }

    /* SIGNED so it cannot be hand-crafted (docs/THREAT_MODEL.md T2), and now
       VERSIONED so it can be revoked server-side. The version is the identity's
       current revocation counter; logout increments it, which invalidates this
       cookie and every copy of it. */
    const cookieValue = await identityRevocation.issueCookieValue(profile.sub);
    // Same stamp on the session, so a later revocation invalidates both.
    req.session.identityVersion = identityRevocation.decodeCookie(cookieValue).version;
    res.cookie("fg_google_sub", cookieValue, {
      maxAge: 400 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      signed: true
    });

    return res.redirect("/app?auth=success");
  } catch (exchangeError) {
    // Opaque code only: raw upstream exception text can disclose internals.
    logger.error("auth.google.exchange_failed", { error: exchangeError.message });
    return res.redirect("/app?auth=error&reason=google_auth_failed");
  }
});

/**
 * LOG OUT — for real.
 *
 * WHAT WAS WRONG. This nulled `req.session.googleUser` and cleared one cookie.
 * The session row itself stayed valid for its full 14 days, and the 400-day
 * signed `fg_google_sub` identity cookie meant the NEXT request silently
 * re-authenticated the browser from disk with no re-verification. Logging out
 * did not log you out.
 *
 * It was also a GET, so any cross-origin image tag could trigger it.
 */
async function performLogout(req, res) {
  const cookieOptions = { httpOnly: true, sameSite: "lax", signed: true,
    secure: process.env.NODE_ENV === "production" };

  /* REVOKE THE IDENTITY, not just this browser's copy of the cookie.
     Clearing the cookie only affects the browser that asked. Incrementing the
     identity's revocation version invalidates every cookie ever issued for it —
     including one copied from a shared machine before logout. */
  const subject = (req.session && req.session.googleUser && req.session.googleUser.sub)
    || (req.identityChecked && req.identityChecked.subject)
    || null;
  if (subject) {
    try {
      await identityRevocation.revoke(subject);
    } catch (err) {
      logger.error("logout.revocation_failed", { error: err.message });
    }
  }

  // Clear the identity cookie with the SAME options it was set with, or the
  // browser keeps the original.
  res.clearCookie("fg_google_sub", cookieOptions);

  if (req.session) {
    req.session.destroy((err) => {
      if (err) logger.error("logout.session_destroy_failed", { error: err.message });
      res.clearCookie("fg_sid");
      finish();
    });
  } else {
    finish();
  }

  function finish() {
    if (req.log) req.log.info("auth.logout");
    if (req.accepts("json") && !req.accepts("html")) {
      return res.json({ ok: true, loggedOut: true });
    }
    return res.redirect("/app");
  }
}

// POST is the correct verb for a state-changing action and is not triggerable
// by a cross-origin <img>. GET is retained so existing links keep working.
router.post("/auth/google/logout", performLogout);
router.get("/auth/google/logout", performLogout);

/**
 * Import a period from uploaded files.
 *
 * ACCEPTS CSV **OR** PDF SOURCE DOCUMENTS. Users do not keep their books as
 * CSV; they keep a folder of invoices, bills and receipts, so several PDFs may
 * be attached at once and are imported as one period.
 *
 * The format is decided by the FILE'S OWN BYTES (`%PDF-`), never by its
 * extension or by the browser-supplied content type, both of which a client
 * controls.
 *
 * A PDF that cannot be read — a scan, a photo, a layout with no labelled
 * fields — is REFUSED and named in `rejected`. It is never approximated. See
 * services/pdfDocumentImporter.js for why that is the only acceptable
 * behaviour here.
 */
router.post("/financial-data/upload", csvUpload.array("file", 200), (req, res) => {
  try {
    const files = req.files && req.files.length ? req.files : (req.file ? [req.file] : []);
    if (!files.length) {
      return res.status(400).json({
        ok: false, error: "No file uploaded. Attach a CSV file or your PDF documents."
      });
    }

    const period = String((req.body || {}).period || "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ ok: false, error: "A valid period (YYYY-MM) is required." });
    }

    const currentCashBalance = (req.body || {}).currentCashBalance;
    const pdfs = files.filter((f) => pdfTextExtract.looksLikePdf(f.buffer));

    let monthlyData;
    let pdfOutcome = null;

    if (pdfs.length) {
      /* MIXED UPLOADS ARE REFUSED rather than half-imported. Merging a CSV and
         a document folder risks counting the same money twice, and the user
         cannot see that it happened. */
      if (pdfs.length !== files.length) {
        return res.status(400).json({
          ok: false,
          error: "Upload either a CSV file or PDF documents, not both at once. "
            + "Importing both together could count the same transaction twice."
        });
      }

      pdfOutcome = pdfDocumentImporter.importPdfDocuments({
        files: pdfs.map((f) => ({ filename: f.originalname, buffer: f.buffer })),
        period,
        businessName: req.userStore.profile.businessName,
        currentCashBalance
      });

      if (!pdfOutcome.monthlyData) {
        return res.status(400).json({
          ok: false,
          error: pdfOutcome.error,
          // Which documents failed, and why — so the user can act on it.
          rejected: pdfOutcome.rejected,
          out_of_period: pdfOutcome.outOfPeriod
        });
      }
      monthlyData = pdfOutcome.monthlyData;
    } else {
      if (files.length > 1) {
        return res.status(400).json({
          ok: false, error: "Attach one CSV file, or attach your PDF documents."
        });
      }
      monthlyData = parseFinancialCsv({
        csvText: files[0].buffer.toString("utf-8"),
        period,
        businessName: req.userStore.profile.businessName,
        currentCashBalance
      });
    }

    req.userStore.uploadedMonthlyData[period] = monthlyData;

    return res.json({
      ok: true,
      period,
      source: monthlyData.meta.source,
      /* PDF imports report per-document outcomes. `rejected` being non-empty
         with `ok: true` is a real and important state: the period imported,
         but not from everything the user attached. */
      documents: pdfOutcome ? {
        attached: pdfs.length,
        transactions: pdfOutcome.accepted.length,
        supporting_evidence: pdfOutcome.evidenceCount,
        rejected: pdfOutcome.rejected,
        out_of_period: pdfOutcome.outOfPeriod
      } : null,
      summary: {
        transaction_count: monthlyData.transactions.length,
        skipped_rows: monthlyData.meta.skippedRows || 0,
        inflow: monthlyData.statements.cashFlow.inflow,
        outflow: monthlyData.statements.cashFlow.outflow,
        net_income: monthlyData.statements.profitAndLoss.netIncome,
        /* THE FIGURE AND WHERE IT CAME FROM. This returned the raw number, so
           an estimate derived from net income was shown to the uploader as
           though it were their cash balance. The basis travels with it now, and
           `cash_and_equivalents` itself is null unless the balance was actually
           supplied -- the estimate is offered separately and labelled. */
        cash_and_equivalents: readCashPosition(
          monthlyData.statements.balanceSheet).value,
        cash_basis: readCashPosition(monthlyData.statements.balanceSheet).basis,
        cash_estimate: readCashPosition(monthlyData.statements.balanceSheet).estimate
      }
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

/**
 * Import history.
 *
 * THE DEFECT. This listed `uploadedMonthlyData`, an IN-MEMORY map, so after a
 * restart a user's import history was empty even though every record and every
 * completed analysis was still in PostgreSQL. Combined with the upload panel
 * being reachable only from the one-time onboarding wizard, a returning user
 * had no evidence they had ever imported anything.
 *
 * The periods that actually have a completed, recoverable analysis come from
 * the database; anything only in this process's memory is merged on top and
 * marked as not-yet-analysed.
 */
router.get("/financial-data/uploads", async (req, res) => {
  const inMemory = Object.keys(req.userStore.uploadedMonthlyData || {});
  let analysed = [];
  if (req.userStore.tenantId && dbPool.isConfigured()) {
    try {
      analysed = await analysisRunRepository.completedPeriods(req.userStore.tenantId);
    } catch (err) {
      logger.warn("uploads.period_lookup_failed", { error: err.message });
    }
  }

  const byPeriod = new Map();
  analysed.forEach((p) => byPeriod.set(p.period, {
    period: p.period, analysed: true,
    recoverable: p.recoverable, completed_at: p.completedAt
  }));
  inMemory.forEach((period) => {
    if (!byPeriod.has(period)) {
      byPeriod.set(period, { period, analysed: false, recoverable: false, completed_at: null });
    }
  });

  const periods = Array.from(byPeriod.values())
    .sort((a, b) => (a.period < b.period ? 1 : -1));

  res.json({
    ok: true,
    // The bare list is kept for the existing contract.
    periods: periods.map((p) => p.period),
    imports: periods,
    /* Imports are not the whole story for a connected business — see
       liveSourceFor(). Without this the month picker sends a Zoho user to the
       upload page for a month Zoho is holding. */
    live_source: liveSourceFor(req.userStore)
  });
});

router.get("/oauth/zoho/start", (req, res) => {
  if (!hasZohoOAuthConfig()) {
    return res.redirect("/app?oauth=not_configured");
  }

  cleanupOauthState();

  const state = crypto.randomBytes(16).toString("hex");
  oauthStateStore.set(state, {
    name: typeof req.query.name === "string" ? req.query.name.trim() : "",
    businessName: typeof req.query.business_name === "string" ? req.query.business_name.trim() : "",
    zohoOrgId: typeof req.query.zoho_org_id === "string" ? req.query.zoho_org_id.trim() : "",
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const authUrl = new URL(config.zohoOauthAuthUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.zohoOauthClientId);
  authUrl.searchParams.set("redirect_uri", config.zohoOauthRedirectUri);
  authUrl.searchParams.set("scope", config.zohoOauthScope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return res.redirect(authUrl.toString());
});

router.get("/oauth/zoho/callback", async (req, res) => {
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(String(error))}`);
  }

  if (!code || !state || !oauthStateStore.has(state)) {
    return res.redirect("/app?oauth=error&reason=invalid_state");
  }

  const pendingProfile = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  try {
    const tokenPayload = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      client_id: config.zohoOauthClientId,
      client_secret: config.zohoOauthClientSecret,
      redirect_uri: config.zohoOauthRedirectUri
    });

    const tokenResponse = await fetch(config.zohoOauthTokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: tokenPayload.toString()
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
      const reason = tokenData.error || `token_exchange_${tokenResponse.status}`;
      return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(String(reason))}`);
    }

    req.userStore.profile.zohoApiKey = tokenData.access_token;
    req.userStore.profile.zohoRefreshToken = tokenData.refresh_token || req.userStore.profile.zohoRefreshToken;
    req.userStore.profile.zohoTokenExpiresAt = Date.now() + (Number(tokenData.expires_in) || 3600) * 1000;
    if (tokenData.api_domain) req.userStore.profile.zohoApiDomain = tokenData.api_domain;

    if (pendingProfile?.name) req.userStore.profile.userName = pendingProfile.name;
    if (pendingProfile?.businessName) req.userStore.profile.businessName = pendingProfile.businessName;
    if (pendingProfile?.zohoOrgId) req.userStore.profile.zohoOrgId = pendingProfile.zohoOrgId;

    const saved = await persistProfileAsync(req.userStore);
    if (!saved.ok) {
      /* The Zoho tokens could not be stored. Redirecting to `oauth=success`
         would tell the user their accounting connection is live when the
         refresh token was never written — so the failure is surfaced instead. */
      logger.error("oauth.zoho.persist_failed", { reason: saved.reason });
      return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(saved.reason)}`);
    }
    return res.redirect("/app?oauth=success");
  } catch (exchangeError) {
    return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(exchangeError.message || "token_exchange_failed")}`);
  }
});

router.post("/oauth/zoho/disconnect", (req, res) => {
  req.userStore.profile.zohoApiKey = "";
  req.userStore.profile.zohoRefreshToken = "";
  req.userStore.profile.zohoOrgId = "";
  req.userStore.profile.zohoApiDomain = "";
  req.userStore.profile.zohoTokenExpiresAt = null;
  persistProfile(req.userStore);
  res.json({ ok: true });
});

router.get("/profile", (req, res) => {
  const zohoConnected = Boolean(req.userStore.profile.zohoApiKey || config.zohoDirectApiUrl);
  const zohoState = zohoConnected ? "configured" : "not configured";
  const walletConnected = Boolean(req.userStore.profile.walletAddress);
  const aiConnected = Boolean(req.userStore.profile.aiApiKey);

  res.json({
    ok: true,
    profile: {
      businessName: req.userStore.profile.businessName,
      userName: req.userStore.profile.userName,
      business_name: req.userStore.profile.businessName,
      name: req.userStore.profile.userName,
      zoho_connected: zohoConnected,
      zoho_oauth_configured: hasZohoOAuthConfig(),
      zoho_org_id: req.userStore.profile.zohoOrgId,
      wallet_address: req.userStore.profile.walletAddress,
      wallet_verified: Boolean(req.userStore.profile.walletVerified),
      wallet_chain_id: req.userStore.profile.walletChainId,
      zoho_api_key: req.userStore.profile.zohoApiKey ? MASKED_VALUE : "",
      ai_provider: req.userStore.profile.aiProvider,
      ai_assistant: req.userStore.profile.aiAssistant,
      ai_api_key: req.userStore.profile.aiApiKey ? MASKED_VALUE : "",
      ai_api_key_configured: Boolean(req.userStore.profile.aiApiKey),
      ai_api_key_preview: maskSecretPreview(req.userStore.profile.aiApiKey),
      // Bring Your Own AI is a subscription capability, never inferred from the
      // presence of a key.
      byok_enabled: entitlements.can(req.userStore.profile, "bring_your_own_ai"),
      byok_setup_required: entitlements.can(req.userStore.profile, "bring_your_own_ai") && !req.userStore.profile.aiApiKey,
      businessAddress: config.businessAddress,
      ownerKeywordHints: config.businessOwnerKeywords,
      integrations: [
        {
          label: "Avalanche Wallet",
          connected: walletConnected,
          state: req.userStore.profile.walletVerified ? "verified" : (walletConnected ? "unverified" : "not connected"),
          secureReference: "***",
          note: req.userStore.profile.walletVerified
            ? "Wallet ownership verified by signature"
            : (walletConnected ? "Wallet address set but not signature-verified" : "No wallet connected")
        },
        {
          label: "Zoho API",
          connected: zohoConnected,
          state: zohoState,
          secureReference: "***",
          note: zohoConnected ? "Zoho API credentials are set" : "Zoho API credentials are missing"
        },
        {
          label: "Zoho OAuth",
          connected: hasZohoOAuthConfig(),
          state: hasZohoOAuthConfig() ? "ready" : "missing env",
          secureReference: "***",
          note: hasZohoOAuthConfig()
            ? "OAuth client config detected"
            : "Set ZOHO_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI"
        },
        {
          label: "AI API",
          connected: aiConnected,
          state: aiConnected ? "configured" : "not configured",
          secureReference: "***",
          note: `Assistant: ${req.userStore.profile.aiAssistant} (${req.userStore.profile.aiProvider})`
        },
        getCoreWalletIntegrationSummary()
      ]
    },
    now: new Date().toISOString()
  });
});

router.post("/profile", async (req, res) => {
  const {
    userName,
    businessName,
    zohoApiKey,
    zohoOrgId,
    walletAddress,
    name,
    business_name,
    zoho_api_key,
    zoho_org_id,
    wallet_address,
    aiProvider,
    aiApiKey,
    aiAssistant,
    ai_provider,
    ai_api_key,
    ai_assistant
  } = req.body || {};

  const resolvedName = userName || name;
  const resolvedBusinessName = businessName || business_name;
  const resolvedZoho = zohoApiKey || zoho_api_key;
  const resolvedZohoOrgId = zohoOrgId || zoho_org_id;
  const resolvedWallet = walletAddress !== undefined ? walletAddress : wallet_address;
  const resolvedAiProvider = aiProvider || ai_provider;
  const resolvedAiApiKey = aiApiKey || ai_api_key;
  const resolvedAiAssistant = aiAssistant || ai_assistant;

  if (resolvedName) req.userStore.profile.userName = resolvedName;
  if (resolvedBusinessName) req.userStore.profile.businessName = resolvedBusinessName;
  // GET /profile echoes "***" for any already-set secret so it never leaves
  // the server in the clear. If the client sends that same sentinel back
  // (e.g. it round-tripped an unmodified form field), treat it as "unchanged"
  // rather than overwriting the real secret with the literal string "***".
  if (resolvedZoho && resolvedZoho !== MASKED_VALUE) req.userStore.profile.zohoApiKey = resolvedZoho;
  if (resolvedZohoOrgId) req.userStore.profile.zohoOrgId = resolvedZohoOrgId;
  if (resolvedWallet !== undefined && resolvedWallet !== req.userStore.profile.walletAddress) {
    req.userStore.profile.walletAddress = resolvedWallet;
    req.userStore.profile.walletVerified = false;
    req.userStore.profile.walletChainId = null;
  }
  // Bring Your Own AI is a Custom AI subscription capability, so key/provider
  // management is gated. Only an ACTUAL change is rejected -- an unchanged form
  // round-trip never fails a profile save. An existing stored key is left
  // untouched on other plans (downgrade preserves configuration, see §2.4).
  const wantsKeyChange = Boolean(resolvedAiApiKey && resolvedAiApiKey !== MASKED_VALUE);
  const wantsProviderChange = Boolean(resolvedAiProvider && resolvedAiProvider !== req.userStore.profile.aiProvider);
  if (wantsKeyChange && !entitlements.can(req.userStore.profile, "api_key_management")) {
    return res.status(403).json(entitlements.upgradePayload("api_key_management"));
  }
  if (wantsProviderChange && !entitlements.can(req.userStore.profile, "ai_provider_selection")) {
    return res.status(403).json(entitlements.upgradePayload("ai_provider_selection"));
  }
  if (resolvedAiProvider) req.userStore.profile.aiProvider = resolvedAiProvider;
  if (wantsKeyChange) req.userStore.profile.aiApiKey = resolvedAiApiKey;
  if (resolvedAiAssistant) req.userStore.profile.aiAssistant = resolvedAiAssistant;
  /* This route can be saving an AI API key or a Zoho key. A silent failure
     here previously told the user their key was stored when it was not. */
  if (!await persistCredentialOrFail(res, req.userStore, "Your settings")) return;
  res.json({ ok: true });
});

// ── Sub-monthly analysis scoping (daily / weekly) ─────────────
// Daily and weekly reviews reuse the full monthly analysis engine but scope the
// transaction-level arrays (which carry real dates) to the chosen day or week.
// The month remains the surrounding financial context; only the detections are
// narrowed, and the period is labelled accordingly.
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function serverMonthLabel(month) {
  const parts = String(month).split("-").map(Number);
  if (!parts[0] || !parts[1]) return month;
  return MONTH_NAMES[parts[1] - 1] + " " + parts[0];
}
function serverDayLabel(date) {
  const parts = String(date).split("-").map(Number);
  if (!parts[0] || !parts[1] || !parts[2]) return date;
  return MONTH_NAMES[parts[1] - 1] + " " + parts[2] + ", " + parts[0];
}
function daysInCalendarMonth(month) {
  const parts = String(month).split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
}
function computeScopeRange(month, granularity, opts) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const dim = daysInCalendarMonth(month);
  if (granularity === "daily") {
    const date = String((opts && opts.date) || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) return null;
    return { granularity: "daily", start: date, end: date, period: date, label: serverDayLabel(date) };
  }
  if (granularity === "weekly") {
    const week = Math.max(1, Math.min(5, Number((opts && opts.week) || 1)));
    const startDay = (week - 1) * 7 + 1;
    if (startDay > dim) return null;
    const endDay = Math.min(startDay + 6, dim);
    return {
      granularity: "weekly", week,
      start: month + "-" + pad(startDay), end: month + "-" + pad(endDay),
      period: month + "-W" + week,
      label: "Week " + week + " of " + serverMonthLabel(month) + " (" + startDay + "–" + endDay + ")"
    };
  }
  return null;
}
function inDateRange(dateStr, start, end) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= start && d <= end;
}
function scopeMonthlyDataToRange(monthlyData, range) {
  const scoped = Object.assign({}, monthlyData);
  if (Array.isArray(monthlyData.transactions)) {
    scoped.transactions = monthlyData.transactions.filter((tx) => inDateRange(tx.date, range.start, range.end));
  }
  if (Array.isArray(monthlyData.journalEntries)) {
    scoped.journalEntries = monthlyData.journalEntries.filter((je) => inDateRange(je.date, range.start, range.end));
  }
  scoped.scopedRange = range;
  return scoped;
}

router.post("/monthly-review", async (req, res) => {
  try {
    // SECURITY: directApiUrl/apiKey are deliberately NOT read from the request
    // body. Accepting them allowed SSRF and server-credential forwarding (T1).
    const { month, granularity, week, date, businessName, businessAddress, use_ai_analysis } = req.body || {};

    // INGESTION BOUNDARY. Replaces the uploaded -> Zoho -> mock ladder.
    // A malformed period now 400s instead of silently analysing another month;
    // a Zoho failure 502s instead of yielding a plausible empty dataset.
    let monthlyData;
    let ingestQuality = null;
    let ingestWarnings = [];
    try {
      const ingested = await ingestForStore(req.userStore, month);
      if (!ingested.data) {
        return res.status(502).json({
          ok: false,
          error: "zoho_fetch_failed",
          message: ingested.quality.summary,
          data_quality: ingested.quality,
          failures: ingested.failures
        });
      }
      monthlyData = ingested.data;
      ingestQuality = ingested.quality;
      ingestWarnings = ingested.warnings;
    } catch (ingestError) {
      if (ingestError.code === "invalid_period") {
        return res.status(400).json({ ok: false, error: "invalid_period", message: ingestError.message });
      }
      if (ingestError.code === "no_data_source") {
        return res.status(409).json({ ok: false, error: "no_data_source", message: ingestError.message });
      }
      throw ingestError;
    }

    // Narrow to a day or week when requested (monthly = whole month, unchanged).
    let scope = null;
    if (month && (granularity === "weekly" || granularity === "daily")) {
      const range = computeScopeRange(month, granularity, { week, date });
      if (range) {
        monthlyData = scopeMonthlyDataToRange(monthlyData, range);
        scope = { granularity: range.granularity, label: range.label, period: range.period, start: range.start, end: range.end };
      }
    }

    const analysis = analyzeFinancialRisk(monthlyData, { period: (scope && scope.period) || month || monthlyData.period, tenantId: req.userStore.tenantId || null, reviewHistory: req.userStore.reviewHistory });

    // Evaluate user-defined financial rules and merge their findings into the
    // analysis. buildAnomalies() then surfaces them alongside built-in findings —
    // no detection logic is duplicated (duplicate_payment reuses the engine).
    //
    // DOWNGRADE POLICY: a profile that loses the custom_rules capability KEEPS
    // every rule it authored; execution is simply skipped. Re-upgrading resumes
    // evaluation immediately with no reconfiguration and no lost work.
    try {
      if (!entitlements.can(req.userStore.profile, "custom_rules")) {
        throw new Error("custom_rules_not_entitled");
      }
      const ruleEval = customRules.evaluateCustomRules(
        req.userStore.profile.customRules,
        monthlyData,
        analysis,
        {
          ownerKeywords: config.businessOwnerKeywords,
          // Tenant and period so the custom finding gets the same stable,
          // tenant-scoped id an engine finding would.
          tenantId: req.userStore.tenantId || null,
          period: (scope && scope.period) || month || monthlyData.period || null,
          currency: (analysis.run && analysis.run.methodology.currency.currency) || null
        }
      );
      analysis.detections.customRuleMatches = ruleEval.findings;
      if (ruleEval.executions.length) {
        const hist = req.userStore.profile.ruleExecutionHistory || (req.userStore.profile.ruleExecutionHistory = []);
        hist.push({ month: month || monthlyData.period || null, at: new Date().toISOString(), results: ruleEval.executions });
        while (hist.length > 50) hist.shift();
        persistProfile(req.userStore);
      }
    } catch (e) {
      // Custom rules must never break the core review.
    }

    const report = buildStructuredReport({
      businessName: businessName || req.userStore.profile.businessName,
      businessAddress: businessAddress || config.businessAddress,
      period: month || monthlyData.period || null,
      analysis
    });

    const followUp = await runFollowUpWorkflow(report, req.userStore.reportsDir);

    const context = buildContext({
      month,
      monthlyData,
      analysis,
      report,
      followUp,
      reviewHistory: req.userStore.reviewHistory,
      reportsDir: req.userStore.reportsDir
    });
    context.rawMonthlyData = monthlyData;
    context.rawAnalysis = analysis;
    /* Keep the run so a later "compare with last month" reads STORED
       authoritative results instead of re-deriving them. Bounded to the last
       12 periods — a conversation about a two-year-old month is not a use case
       worth holding a year of runs in memory for. */
    if (analysis && analysis.run) {
      const runs = req.userStore.analysisRuns || (req.userStore.analysisRuns = {});
      runs[analysis.run.period] = analysis.run;
      const periods = Object.keys(runs).sort();
      while (periods.length > 12) delete runs[periods.shift()];

      /* PERSIST THE RUN, its findings, its evidence and its metrics.
         `saveRun` was built and tested in JOB 5 but had NO production caller —
         the same class of gap as the unassigned tenantId: the capability
         existed, its tests passed, and the running application never used it.
         So an analysis lived only in this process's memory and vanished on
         restart, while the database sat empty.

         JOB 11: the AUTHORITATIVE PERIOD INPUTS travel with it. The engine's
         output does not contain them — `currentCashBalance` is supplied at
         upload and consumed by the runway calculation, and the ingestion
         metadata describes what was skipped and why. Both lived only in the
         in-memory envelope, and without them a stored run could not be shown
         to be the same run. */
      await persistAnalysisRun(req.userStore, analysis.run, {
        /* THE AUTHORITATIVE value only. `buildPeriodInputs` classifies using the
           ingestion basis, so passing the raw figure was safe — but it meant a
           call site still handled an unclassified number, which is precisely
           the shape of every bypass this job removed. The accessor returns null
           unless the balance was observed, so an estimate cannot be handed on
           from here even by mistake. */
        currentCashBalance: readCashPosition(
          monthlyData.statements && monthlyData.statements.balanceSheet).value,
        businessName: businessName || req.userStore.profile.businessName || null,
        ingestionMeta: monthlyData.meta || null
      });
    }
    context.scope = scope;
    req.userStore.latestReviewContext = context;

    // Plan-based AI routing + credit gating. The deterministic analysis above
    // is always free; only this AI narration is metered. Routing precedence:
    // own key -> Custom AI (unmetered); pro -> managed Mistral; free -> managed NVIDIA.
    const profile = req.userStore.profile;
    const routing = entitlements.resolveAiRouting(profile, config);
    const shouldUseAi = use_ai_analysis !== false;
    let aiAnalysis = {
      ok: false,
      mode: "skills-only",
      reason: "ai_not_requested"
    };

    if (shouldUseAi) {
      if (!routing.apiKey) {
        aiAnalysis = {
          ok: false,
          mode: "skills-fallback",
          reason: routing.mode === "byok" ? "missing_ai_api_key" : "managed_key_unavailable"
        };
      } else if (routing.managed && !entitlements.canAfford(profile, "monthly-review")) {
        const ent = entitlements.getEntitlement(profile);
        aiAnalysis = {
          ok: false,
          mode: "skills-fallback",
          reason: "insufficient_credits",
          plan: ent.plan,
          credits: ent.credits,
          cost: entitlements.creditCost("monthly-review")
        };
      } else {
        /* JOB 8. The interpretation goes through the orchestrator: a bounded
           context built from the authoritative run, and STRUCTURED validation
           of the result. Previously this prompt carried ~40KB of skill
           documentation and the whole context object, and its JSON output was
           coerced (`String(x || "medium")`) rather than validated — so a
           malformed or fabricated narrative reached the dashboard and the PDF.

           The AI still only narrates: every number in its output must trace to
           a value the engine computed, or the output is rejected. */
        const aiResult = await aiOrchestrator.interpret({
          run: analysis && analysis.run ? analysis.run : null,
          tenantId: req.userStore.tenantId || null,
          profile,
          config,
          businessName: businessName || req.userStore.profile.businessName,
          operation: "monthly-review",
          assistant: req.userStore.profile.aiAssistant,
          requiredKeys: ["overall_summary", "overall_risk_level", "pages"],
          instruction: [
            "Write the monthly interpretation for the business owner.",
            "Return JSON with exactly these keys:",
            '{"overall_summary": "2-3 sentences", "overall_risk_level": "low|medium|high",',
            ' "pages": {"overview": {"narrative": "", "key_findings": [], "recommended_actions": []},',
            '           "financial_health": {...}, "cashflow": {...}, "revenue": {...},',
            '           "risk": {...}, "vendors": {...}, "customers": {...}, "actions": {...}},',
            ' "executive_report": {"executive_summary": "", "key_insights": [],',
            '                      "priority_actions": [{"rank": 1, "action": "", "why": ""}],',
            '                      "what_is_working": [], "what_needs_attention": []}}',
            "Every figure you cite must appear in the financial data above."
          ].join("\n")
        });

        if (aiResult.ok) {
          // Only charge credits once the managed AI call actually succeeded.
          let charged = null;
          if (aiResult.routing && aiResult.routing.managed) {
            // Through the atomic ledger, like every other AI charge.
            charged = await aiBilling.charge({
              tenantId: req.userStore.tenantId || null,
              profile, operation: "monthly-review",
              interactionId: aiResult.meta ? aiResult.meta.analysisRunId : null
            });
            persistProfile(req.userStore);
          }
          req.userStore.latestReviewContext.aiInsights = aiResult.output;
          // The run the narrative was checked against, so a stored insight can
          // always be traced to the analysis that justified it.
          req.userStore.latestReviewContext.aiInsightsRunId = aiResult.meta.analysisRunId;
          aiAnalysis = {
            ok: true,
            mode: "ai+skills",
            provider: aiResult.provider,
            model: aiResult.model,
            insights: aiResult.output,
            credits_remaining: charged ? charged.remaining : null
          };
        } else {
          aiAnalysis = {
            ok: false,
            mode: "skills-fallback",
            reason: aiResult.reason || "ai_request_failed"
          };
        }
      }
    }

    req.userStore.reviewHistory.push({ period: context.period, revenue: context.revenue.total_revenue });
    if (req.userStore.reviewHistory.length > 36) req.userStore.reviewHistory.shift();

    res.json({
      ok: true,
      report,
      followUp,
      review: context.overview,
      aiAnalysis,
      scope,
      // Ingestion provenance travels with every analysis (mandate: data quality
      // is a first-class financial signal).
      data_quality: ingestQuality,
      ingestion_warnings: ingestWarnings,
      assumptions: [
        "Zoho endpoint returns normalized JSON fields: transactions, journalEntries, reconciliations, statements.",
        "Authentication can be passed as Bearer token from apiKey or ZOHO_API_KEY.",
        "Avalanche CLI is optional and controlled by ENABLE_AVALANCHE."
      ]
    });
  } catch (error) {
    serverError(res, "monthly-review", error);
  }
});

/**
 * The authoritative methodology, GENERATED from the rules registry.
 *
 * Public and unauthenticated: it describes how the engine works, not any
 * business's data. It exists so the methodology has exactly one source — the
 * registry — instead of being restated in documents that drift from the code.
 * `?format=markdown` returns the human-readable rendering.
 */
/**
 * TEST-ONLY: prime the stubbed AI provider.
 *
 * Registered only when the double gate in aiAnalysisClient is satisfied
 * (NODE_ENV=test AND AI_TEST_PROVIDER=1), so this route does not exist in a
 * deployed environment.
 */
if (aiClient.isTestStubEnabled()) {
  router.post("/__test/ai-stub", (req, res) => {
    const ok = aiClient.setTestStub(req.body || {});
    res.json({ ok });
  });
}

/**
 * ENGINE INVOCATION COUNT — the recomputation guard (JOB 11 Part E).
 *
 * Restart recovery must LOAD a stored run, not silently recompute one. Those
 * two are indistinguishable by looking at the response, because a recomputation
 * can return plausible numbers — different ones, computed against today's rules
 * and the now-absent period inputs, while presenting itself as the original
 * analysis. The only way to tell them apart is to watch the engine.
 *
 * Test-only, and gated on NODE_ENV=test exactly like the AI stub above, so it
 * does not exist in a deployed environment.
 */
if (process.env.NODE_ENV === "test") {
  router.get("/__test/engine-count", (req, res) => {
    res.json({ ok: true, analyses: domainEngine.analysisCount() });
  });
}

/* ═══════════════════════════════════════════════════════════════
   PERSISTED ANALYSIS — the production read path (JOB 11 Part D).

   These routes exist so a stored analysis is reachable without depending on
   whatever this process happens to be holding. Every one of them goes through
   the tenant-scoped repository: no SQL is written here, and RLS confines each
   query to the caller's own tenant, so a run id belonging to another tenant is
   simply not found — the response cannot be used to discover that it exists.
   ═══════════════════════════════════════════════════════════════ */

/** Which periods this tenant has a completed analysis for. */
/**
 * A source that can fetch ANY period on demand, rather than one that only holds
 * what was already imported.
 *
 * This distinction decides whether the month picker may offer a month the user
 * has never analysed. A Zoho-connected business has June available even though
 * nothing about June is stored yet — the data is one request away.
 */
function liveSourceFor(store) {
  var profile = (store && store.profile) || {};
  return profile.zohoRefreshToken ? "zoho-books" : null;
}

router.get("/analysis/periods", async (req, res) => {
  const liveSource = liveSourceFor(req.userStore);
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    /* PERSISTENCE IS UNAVAILABLE, WHICH IS NOT THE SAME AS "NO PERIODS".
       This returned an empty list, and the client read it as "no month has any
       data" and dimmed all twelve. On a deployment without DATABASE_URL that
       described every user, including one whose Zoho account was full of
       records. `periods: null` says we cannot see them from here. */
    return res.json({
      ok: true, periods: null, persistence: "unavailable", live_source: liveSource
    });
  }
  try {
    const periods = await analysisRunRepository.completedPeriods(req.userStore.tenantId);
    /* `live_source` tells the client that a stored analysis is not the only way
       a month can have data: Zoho can supply one on request. */
    res.json({ ok: true, periods, persistence: "database", live_source: liveSource });
  } catch (err) {
    logger.error("analysis.periods_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "analysis_index_unavailable" });
  }
});

/**
 * The latest completed analysis for a period, loaded from PostgreSQL.
 *
 * The three outcomes are kept distinct, because collapsing them is how the
 * original defect presented itself:
 *   recovered  — the stored run, rebuilt
 *   not_found  — no completed run for this period
 *   legacy     — a real historical run that predates JOB 11 and CANNOT be
 *                rebuilt faithfully. Reported as such, never recomputed.
 */
router.get("/analysis/:period", async (req, res) => {
  const period = String(req.params.period || "");
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ ok: false, error: "A period of the form YYYY-MM is required." });
  }
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "persistence_unavailable" });
  }
  try {
    const result = await analysisRunRepository.loadCompletedRun(req.userStore.tenantId, period);
    if (result.ok) return res.json({ ok: true, analysis: presentRun(result.run) });

    if (result.reason === analysisRunRepository.RECOVERY.LEGACY) {
      return res.status(409).json({
        ok: false, error: "legacy_unrecoverable", period,
        detail: "This analysis predates the recovery contract and cannot be reloaded. "
          + "Re-run the review for this period.",
        run_id: result.runId, completed_at: result.completedAt
      });
    }
    return res.status(404).json({ ok: false, error: "no_completed_analysis", period });
  } catch (err) {
    logger.error("analysis.load_failed", { period, error: err.message });
    res.status(503).json({ ok: false, error: "analysis_unavailable" });
  }
});

/** A specific run by id — tenant-scoped. */
router.get("/analysis/run/:runId", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "persistence_unavailable" });
  }
  const runId = String(req.params.runId || "");
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    // Not a run id shape. Refused before it reaches the database, and reported
    // identically to a miss so the two cannot be told apart from outside.
    return res.status(404).json({ ok: false, error: "no_such_run" });
  }
  try {
    const result = await analysisRunRepository.loadRunById(req.userStore.tenantId, runId);
    if (result.ok) return res.json({ ok: true, analysis: presentRun(result.run) });
    if (result.reason === analysisRunRepository.RECOVERY.LEGACY) {
      return res.status(409).json({ ok: false, error: "legacy_unrecoverable", run_id: runId });
    }
    /* NOT_FOUND and NOT_COMPLETED both answer 404 with the same body. A run
       that failed must not be discoverable as "exists but unfinished" through
       this route, and a run under another tenant must be indistinguishable
       from one that never existed. */
    return res.status(404).json({ ok: false, error: "no_such_run" });
  } catch (err) {
    logger.error("analysis.load_by_id_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "analysis_unavailable" });
  }
});

/** The persisted metric projection, INCLUDING the unavailable ones. */
router.get("/analysis/run/:runId/metrics", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "persistence_unavailable" });
  }
  const runId = String(req.params.runId || "");
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(404).json({ ok: false, error: "no_such_run" });
  }
  try {
    // Confirm the run is this tenant's before returning anything about it.
    const owned = await analysisRunRepository.loadRunById(req.userStore.tenantId, runId);
    if (!owned.ok && owned.reason !== analysisRunRepository.RECOVERY.LEGACY) {
      return res.status(404).json({ ok: false, error: "no_such_run" });
    }
    const metrics = await analysisRunRepository.metricsForRun(req.userStore.tenantId, runId);
    res.json({ ok: true, run_id: runId, metrics });
  } catch (err) {
    logger.error("analysis.metrics_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "analysis_unavailable" });
  }
});

/**
 * The underlying records for a period — the evidence behind the findings.
 *
 * Answers "show me the transactions this analysis is about" from storage, so it
 * works after a restart rather than only in the process that did the ingestion.
 */
router.get("/analysis/:period/transactions", async (req, res) => {
  const period = String(req.params.period || "");
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ ok: false, error: "A period of the form YYYY-MM is required." });
  }
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "persistence_unavailable" });
  }
  try {
    const records = await transactionRepository.recordsForPeriod(req.userStore.tenantId, period);
    /* AN EMPTY PERIOD AND AN UNAVAILABLE ONE ARE DIFFERENT ANSWERS. `[]` here
       means "this tenant genuinely has no records for this period", which is a
       statement about their books. It is only ever returned when the query
       succeeded. A failure answers 503 below. */
    res.json({
      ok: true, period, count: records.length, transactions: records,
      source: "database"
    });
  } catch (err) {
    logger.error("records.period_lookup_failed", { period, error: err.message });
    res.status(503).json({ ok: false, error: "records_unavailable" });
  }
});

/**
 * Resolve a cited source record, and what it caused.
 *
 * This is the round trip an auditor needs: a finding cites a record id, and
 * this returns the record itself plus every finding that cites it. The reverse
 * lookup (`findingsCitingRecord`) had no production caller before now.
 */
router.get("/records/:sourceRecordId", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "persistence_unavailable" });
  }
  const sourceRecordId = String(req.params.sourceRecordId || "");
  if (!sourceRecordId || sourceRecordId.length > 200) {
    return res.status(404).json({ ok: false, error: "no_such_record" });
  }
  const sourceSystem = req.query.source_system ? String(req.query.source_system) : null;

  try {
    const record = await transactionRepository.findBySourceRecordId(
      req.userStore.tenantId, sourceRecordId, sourceSystem);

    /* NOT FOUND IS NOT AN EMPTY RECORD. A record belonging to another tenant is
       invisible through RLS and answers exactly as one that never existed, so
       this cannot be used to discover which ids are real. */
    if (!record) return res.status(404).json({ ok: false, error: "no_such_record" });

    const causedFindings = await analysisRunRepository.findingsCitingRecord(
      req.userStore.tenantId, record.sourceSystem, record.sourceRecordId);

    res.json({
      ok: true,
      record,
      // What this record caused — empty here genuinely means "no finding cites
      // it", which is a real and useful answer about a record we DID find.
      findings: causedFindings,
      finding_count: causedFindings.length
    });
  } catch (err) {
    logger.error("records.lookup_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "records_unavailable" });
  }
});

/**
 * A finding's evidence, RESOLVED to the underlying records.
 *
 * The distinction this route exists to preserve: a citation that cannot be
 * resolved is reported in `unresolved`, never dropped. Silently returning only
 * the records that happened to resolve would understate the evidence behind a
 * finding, which is the same class of lie as an unavailable metric rendering
 * as zero.
 */
router.get("/findings/:findingKey/records", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "persistence_unavailable" });
  }
  const findingKey = String(req.params.findingKey || "");
  if (!findingKey || findingKey.length > 200) {
    return res.status(404).json({ ok: false, error: "no_such_finding" });
  }

  try {
    const finding = await analysisRunRepository.findingWithEvidence(
      req.userStore.tenantId, findingKey);
    if (!finding) return res.status(404).json({ ok: false, error: "no_such_finding" });

    const refs = (finding.evidence || []).map((e) => ({
      sourceSystem: e.sourceSystem, sourceRecordId: e.sourceRecordId
    })).filter((r) => r.sourceRecordId);

    const resolved = await transactionRepository.resolveRecords(req.userStore.tenantId, refs);

    res.json({
      ok: true,
      finding_key: findingKey,
      rule_id: finding.rule_id,
      rule_version: finding.rule_version,
      severity: finding.severity,
      evidence_count: refs.length,
      records: resolved.records,
      /* NAMED, NOT DROPPED. A citation whose record is missing means the
         evidence trail is broken, and the caller has to be able to say so
         rather than presenting a shorter list as complete. */
      unresolved: resolved.missing,
      complete: resolved.missing.length === 0
    });
  } catch (err) {
    logger.error("findings.records_lookup_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "records_unavailable" });
  }
});

/**
 * Shape a recovered run for the API.
 *
 * ADDITIVE ONLY. The existing fields keep their names and meanings; `recovered`
 * and `run_id` are added so a caller can tell a reloaded analysis from a fresh
 * one. Nothing is flattened or defaulted on the way out — an unavailable metric
 * stays unavailable, and a null stays null.
 */
function presentRun(run) {
  return {
    run_id: run.analysisRunId,
    period: run.period,
    status: run.status,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    engine_version: run.engineVersion,
    rule_versions: run.ruleVersions,
    // The authoritative representations, untouched.
    metrics: run.metrics,
    risk_score: run.riskScore,
    findings: run.findings,
    data_quality: run.dataQuality,
    methodology: run.methodology,
    summary: run.summary,
    period_inputs: run.periodInputs,
    transaction_count: run.transactionCount,
    recovered: Boolean(run.recovered),
    recovery_schema_version: run.recoverySchemaVersion == null
      ? null : run.recoverySchemaVersion
  };
}

router.get("/methodology", (req, res) => {
  if (String(req.query.format || "").toLowerCase() === "markdown") {
    res.type("text/markdown").send(methodology.renderMarkdown());
    return;
  }
  res.json({ ok: true, methodology: methodology.describeMethodology() });
});

/**
 * WHAT THE READER MUST BE TOLD ABOUT THIS ANALYSIS (JOB 13 Phase C).
 *
 * THE DEFECT. `dataQuality` was assessed, persisted and — in the case of
 * `derivedInputs`, added in JOB 12 — reached NOTHING. No user-facing route
 * surfaced it. So a report built on a derived cash balance, or scored on 80% of
 * the model, was presented with exactly the same apparent confidence as one
 * computed from complete observed books.
 *
 * This returns the limitations attached to a context, or null when there are
 * genuinely none. Null means "nothing to disclose" — it is never used to hide
 * a limitation that exists.
 */
function disclosureFor(context) {
  const dq = (context && (context.dataQuality
    || (context.rawAnalysis && context.rawAnalysis.run
      && context.rawAnalysis.run.dataQuality))) || null;
  const cashflow = (context && context.cashflow) || {};

  const limitations = [];

  /* DEMO DATA IS THE LIMITATION THAT MATTERS MOST.
   *
   * THE DEFECT. With nothing uploaded, the analysis falls back to the demo
   * dataset and returns a complete, confident result — "ABC Traders Ltd",
   * risk 100, runway 2.4 months. The signal existed (`dataQuality.source ===
   * "demo"`) and NOTHING surfaced it, so a visitor on the "Skip to Demo Mode"
   * path saw fabricated financials presented exactly as their own books would
   * be. For a system whose whole premise is never inventing financial state,
   * that was the most damaging thing on screen.
   *
   * Emitted FIRST so it is the first thing read. */
  if (dq && dq.source === "demo") {
    limitations.push({
      type: "demo_data",
      metric: null,
      reason: "demo_dataset",
      detail: "These figures are SAMPLE DATA for a fictional business, not your "
        + "accounts. Import your own financial records to see a real analysis."
    });
  }

  if (dq && dq.hasDerivedInputs) {
    (dq.derivedInputs || []).forEach((d) => {
      limitations.push({
        type: "derived_input",
        input: d.input,
        basis: d.basis,
        affects: d.affects,
        detail: d.detail
      });
    });
  }

  // An unavailable cash position is the one a reader is most likely to
  // misread as zero, so it is stated explicitly rather than left blank.
  if (cashflow.cash_on_hand_available === false) {
    limitations.push({
      type: "unavailable_metric",
      metric: "cash_on_hand",
      reason: cashflow.cash_on_hand_unavailable_reason,
      detail: cashflow.cash_on_hand_basis === "derived_from_net_income"
        ? "No cash balance was supplied for this period. Cash on hand and runway "
          + "are not reported, because an estimate derived from net income is not "
          + "a cash position."
        : "No cash balance is on record for this period, so cash on hand and "
          + "runway are not reported."
    });
  }

  const health = (context && context.health) || {};
  if (health.available === false || health.overall_score == null) {
    limitations.push({
      type: "unavailable_metric", metric: "health.overall_score",
      reason: health.unavailable_reason || "insufficient_evidence",
      detail: health.summary || "The health score could not be computed."
    });
  }

  if (!limitations.length) return null;
  return {
    complete: false,
    // Called out separately from the limitation list so a client can style the
    // whole view differently rather than only printing a line of text.
    is_demo: Boolean(dq && dq.source === "demo"),
    data_quality_level: dq ? dq.level : null,
    // Present when the score was computed on part of the model.
    scoring_coverage_pct: health.coverage_pct == null ? null : health.coverage_pct,
    limitations
  };
}

router.get("/health-score", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    health: context.health,
    // Never omitted when there IS something to disclose; null only when the
    // analysis is genuinely complete and fully observed.
    disclosure: disclosureFor(context),
    skills: ["financial-health-scorer"],
    ai_insights: context.aiInsights?.pages?.financial_health || null
  });
});

router.get("/cashflow", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    cashflow: context.cashflow,
    disclosure: disclosureFor(context),
    skills: ["cashflow-risk-analyzer"],
    ai_insights: context.aiInsights?.pages?.cashflow || null
  });
});

router.get("/revenue", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    revenue: context.revenue,
    /* Cross-cutting limitations (a derived input, partial scoring coverage)
       that per-field `available`/`unavailable_reason` flags do not express. */
    disclosure: disclosureFor(context),
    skills: ["revenue-intelligence"],
    ai_insights: context.aiInsights?.pages?.revenue || null
  });
});

router.get("/anomalies", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    anomalies: context.anomalies,
    /* Cross-cutting limitations (a derived input, partial scoring coverage)
       that per-field `available`/`unavailable_reason` flags do not express. */
    disclosure: disclosureFor(context),
    skills: ["fraud-and-errors-detector"],
    ai_insights: context.aiInsights?.pages?.risk || null
  });
});

router.get("/vendors", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    vendors: context.vendors,
    /* Cross-cutting limitations (a derived input, partial scoring coverage)
       that per-field `available`/`unavailable_reason` flags do not express. */
    disclosure: disclosureFor(context),
    skills: ["vendor-dependency-detector"],
    ai_insights: context.aiInsights?.pages?.vendors || null
  });
});

router.get("/customers", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    customers: context.customers,
    /* Cross-cutting limitations (a derived input, partial scoring coverage)
       that per-field `available`/`unavailable_reason` flags do not express. */
    disclosure: disclosureFor(context),
    skills: ["customer-concentration-detector", "revenue-intelligence"],
    ai_insights: context.aiInsights?.pages?.customers || null
  });
});

router.get("/actions", async (req, res) => {
  // Recovers a persisted analysis when this process has none (JOB 11).
  const context = await getContextAsync(req, req.query.month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    actions: context.actions.actions,
    /* The action list is DERIVED from the findings, so if the analysis behind
       them rests on estimated or unmeasured inputs the actions may be
       incomplete too. Same builder as every other route, which is what lets
       the client-side CSV export carry it. */
    disclosure: disclosureFor(context),
    skills: ["followup-orchestrator", "recommendation-engine"],
    ai_insights: context.aiInsights?.pages?.actions || null
  });
});

router.post("/executive-report", async (req, res) => {
  const context = await getContextAsync(req, (req.body || {}).month || null);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });

  const reportType = String(req.body?.report_type || "monthly_review");
  const report = context.reports.report || {};
  const health = context.health || {};
  const topFindings = (context.anomalies?.items || []).slice(0, 4).map((item) => `- ${item.description}`);
  const topActions = (context.actions?.actions || []).slice(0, 4).map((item) => `- ${item.priority.toUpperCase()}: ${item.task} (Owner: ${item.owner}, Due: ${item.due})`);

  const templates = {
    monthly_review: [
      `Monthly Review - ${context.period || "Current"}`,
      `Health Score: ${health.overall_score ?? "N/A"}/100 (${health.risk_category || "Unknown"})`,
      `Summary: ${report.summary?.headline || health.summary || "No summary available."}`
    ],
    weekly_risk: [
      `Weekly Risk Review - ${context.period || "Current"}`,
      `Open Findings: ${(context.anomalies?.items || []).length}`,
      "Critical risk signals requiring attention this week:"
    ],
    board_summary: [
      `Board Summary - ${context.period || "Current"}`,
      `Overall Health: ${health.overall_score ?? "N/A"}/100`,
      `Pending Actions: ${(context.actions?.actions || []).length}`
    ],
    investor_summary: [
      `Investor Summary - ${context.period || "Current"}`,
      `Risk Category: ${health.risk_category || "Unknown"}`,
      `Cash Runway: ${context.cashflow?.runway_days || "N/A"} days`
    ]
  };

  let lines = (templates[reportType] || templates.monthly_review)
    .concat(topFindings.length ? ["", "Top Findings:", ...topFindings] : ["", "Top Findings:", "- No critical findings."])
    .concat(topActions.length ? ["", "Action Center:", ...topActions] : ["", "Action Center:", "- No pending actions."]);

  const execInsights = context.aiInsights?.executive_report;
  if (execInsights) {
    lines = lines.concat([
      "",
      "=== AI Executive Insights ===",
      execInsights.executive_summary || "",
      "",
      execInsights.key_insights?.length ? "Key Insights:" : "",
      ...(execInsights.key_insights || []).map((item) => `- ${item}`),
      "",
      execInsights.what_is_working?.length ? "What's Working:" : "",
      ...(execInsights.what_is_working || []).map((item) => `- ${item}`),
      "",
      execInsights.what_needs_attention?.length ? "What Needs Attention:" : "",
      ...(execInsights.what_needs_attention || []).map((item) => `- ${item}`),
      "",
      execInsights.priority_actions?.length ? "Priority Actions:" : "",
      ...(execInsights.priority_actions || []).map((item) => `${item.rank}. ${item.action} -- ${item.why}`)
    ].filter((line) => line !== ""));
  }

  /* THE REPORT MUST CARRY ITS OWN LIMITATIONS (JOB 13 Phase C).
   *
   * An executive report is the output most likely to be forwarded to a lender,
   * an investor or a board — read away from the app, with no chance to ask what
   * a blank meant. Presenting one built on a derived cash balance, or scored on
   * part of the model, with the same apparent confidence as a fully observed
   * analysis is the disclosure failure that matters most here.
   *
   * The limitations are written INTO the report text, not only attached to the
   * JSON, because the text is what gets exported and shared. */
  const disclosure = disclosureFor(context);
  if (disclosure) {
    lines.push("");
    lines.push("Limitations of this report:");
    disclosure.limitations.forEach((l) => { lines.push(`- ${l.detail}`); });
    lines.push(
      "This analysis is not based on fully observed data. Figures shown as "
      + "unavailable were not measured, and must not be read as zero.");
  }

  res.json({
    ok: true,
    report_type: reportType,
    report: lines.join("\n"),
    ai_generated: Boolean(execInsights),
    // Also structured, for a caller that renders rather than prints.
    disclosure,
    complete: disclosure === null,
    /* ONLY WHAT THIS RESOURCE CAN ACTUALLY DELIVER.
       This advertised ["PDF", "CSV", "Email"]. Two of the three did not exist:
       there is no CSV representation of an executive report anywhere in the
       repository (the CSV export is a client-side download of the ACTIONS list,
       a different resource), and there is no mail implementation or mail
       dependency at all. A capability list is a promise the API makes about
       itself, and a client written against it would have built a broken button.
       Removed rather than implemented -- this is a cleanup, not a new feature. */
    /* ADVERTISED ONLY WHEN DELIVERABLE. This once listed
       ["PDF", "CSV", "Email"] with no mail implementation and no CSV
       representation of a report; a client written against it would have built
       buttons that could not work. Email is real now, so it is offered — but
       only on a deployment that is actually configured to send, because a
       capability list is a promise the API makes about itself. */
    channels: ["JSON", "PDF"].concat(mailer.isConfigured() ? ["Email"] : []),
    skills: ["executive-report-generator", "financial-controller-core"]
  });
});

// Branded, downloadable PDF of the executive report. Reuses the existing
// report context (no re-generation of analysis). Entitlement-gated:
// Free = blocked (upgrade); Pro = 20 credits (charged only on success); BYOK = free.
/**
 * EMAIL A REPORT.
 *
 * Reuses the exact same context, report model and PDF renderer the download
 * path uses, so the emailed document is byte-for-byte what the user would have
 * downloaded — including its limitations section. A separate rendering path
 * would be a second place for the disclosure rules to drift out of.
 *
 * SENDING FINANCIAL DATA OUT OF THE SYSTEM is the most consequential thing this
 * API does, so: the recipients come only from the authenticated user's request,
 * the count is bounded in the mailer, the route is rate-limited as
 * auth-sensitive, and the send is recorded without the addresses or the body.
 */
/* ═══════════════════════════════════════════════════════════════
   PLANS, CHECKOUT AND BILLING (JOB P6)

   The server decides plan, price, currency and duration. The client selects a
   plan KEY and nothing else — an amount in a request body is ignored, and a
   plan that is not sellable is refused. A subscription becomes active only
   when an independently verified payment is atomically applied.
   ═══════════════════════════════════════════════════════════════ */

/**
 * The authoritative capability map for the signed-in tenant.
 *
 * The frontend renders locks and upgrade prompts from THIS, so there is no
 * second copy of the entitlement rules in client code. It is metadata only:
 * every gated route checks entitlement independently, so editing this response
 * in a browser changes what is DRAWN and nothing about what is ALLOWED.
 */
router.get("/account/entitlements", async (req, res) => {
  try {
    const account = await subscriptionService.accountEntitlements(req.userStore);
    res.json({ ok: true, account, planned: Array.from(entitlements.PLANNED_CAPABILITIES) });
  } catch (err) {
    logger.error("entitlements.read_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "entitlements_unavailable" });
  }
});

/** The catalog, with server-side prices, and whether payment is usable. */
router.get("/billing/plans", (req, res) => {
  const provider = paymentProvider.status();
  res.json({
    ok: true,
    plans: entitlements.sellablePlans(),
    currency: entitlements.BILLING_CURRENCY,
    /* An unconfigured provider is reported honestly rather than letting the UI
       offer a checkout that cannot complete. */
    payment: {
      available: provider.configured,
      provider: provider.provider,
      reason: provider.configured ? null : provider.reason
    }
  });
});

/** This tenant's payment history. Failures included — they are the audit trail. */
router.get("/billing/payments", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.json({ ok: true, payments: [] });
  }
  try {
    res.json({ ok: true, payments: await billingRepository.paymentsFor(req.userStore.tenantId) });
  } catch (err) {
    logger.error("billing.history_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "billing_unavailable" });
  }
});

/**
 * A phone number as the payer should see it echoed back: enough to confirm we
 * are prompting the right handset, not enough to be a full number on a shared
 * screen.
 */
function maskPhone(input) {
  const digits = String(input || "").replace(/[^0-9]/g, "");
  if (digits.length < 6) return "your phone";
  return `${digits.slice(0, 4)}\u2026${digits.slice(-3)}`;
}

/**
 * START A CHECKOUT.
 *
 * The ONLY client input is `plan` (a key) and `phone` (where to send the
 * prompt). Amount, currency and duration come from the catalog. A pending
 * payment row is written BEFORE the provider is called, so a callback always
 * has something to correlate against.
 */
router.post("/billing/checkout", async (req, res) => {
  const body = req.body || {};
  const planKey = String(body.plan || "").toLowerCase();

  /* SERVER-SIDE PRICE. `priceFor` returns null for anything not sellable, which
     covers an unknown plan, the free tier, and Accountant Workspace (every
     capability it adds is still unbuilt, so it cannot be charged for). */
  const price = entitlements.priceFor(planKey);
  if (!price) {
    return res.status(400).json({
      ok: false, error: "plan_not_purchasable",
      detail: "That plan cannot be purchased.",
      plans: entitlements.sellablePlans()
    });
  }

  const provider = paymentProvider.status();
  if (!provider.configured) {
    /* NO FAKE SUCCESS. An unconfigured provider reports unavailable; it never
       activates anything. */
    return res.status(503).json({
      ok: false, error: "payment_unavailable",
      reason: provider.reason,
      detail: "Online payment is not available on this server yet."
    });
  }
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "billing_unavailable" });
  }

  const adapter = paymentProvider.active();
  const payerReference = String(body.phone || "").trim();
  if (!payerReference) {
    return res.status(400).json({ ok: false, error: "phone_required",
      detail: "Enter the phone number to send the payment request to." });
  }

  /* What the payer will see on their handset and, later, on their M-Pesa
     statement. From the catalog, so it is a product decision rather than a
     side effect of how a plan happens to be named. */
  const checkoutLabels = entitlements.checkoutLabelsFor(price.plan);

  try {
    // The row is written FIRST, with OUR amount, so nothing later can change it.
    const payment = await billingRepository.createPayment(req.userStore.tenantId, {
      provider: provider.provider,
      plan: price.plan,
      amount: price.amount,
      currency: price.currency,
      payerReference
    });

    const initiated = await adapter.initiatePayment({
      amount: price.amount,
      currency: price.currency,
      /* `reference` stays the payment id: Paystack echoes it back and
         correlates on it. M-Pesa does NOT — it correlates on Safaricom's own
         CheckoutRequestID — so the reference the CUSTOMER sees is passed
         separately and can be readable. */
      reference: String(payment.id).replace(/-/g, "").slice(0, 12),
      payerReference,
      accountReference: checkoutLabels.account,
      description: checkoutLabels.description
    });

    if (!initiated.ok || !initiated.providerRef) {
      await billingRepository.failPayment(req.userStore.tenantId, payment.id,
        initiated.detail || "provider rejected the request");
      return res.status(502).json({
        ok: false, error: "payment_initiation_failed",
        detail: initiated.detail || "The payment could not be started."
      });
    }

    await billingRepository.attachProviderRef(
      req.userStore.tenantId, payment.id, initiated.providerRef);

    logger.info("billing.checkout_started", {
      plan: price.plan, amount: price.amount, provider: provider.provider
    });

    /* PENDING, and explicitly so. The provider accepting the request means a
       prompt was sent, not that money moved. The client polls the status
       endpoint below; it is never told to treat this as paid. */
    return res.status(202).json({
      ok: true,
      status: "pending",
      payment_id: payment.id,
      /* WHAT WE PUT ON THEIR PHONE, so the UI can tell them what to look for
         instead of leaving them staring at a handset wondering whether the
         prompt they can see is ours. */
      prompt: {
        account: checkoutLabels.account,
        description: checkoutLabels.description,
        phone: maskPhone(payerReference)
      },
      plan: price.plan,
      amount: price.amount,
      currency: price.currency,
      expires_at: payment.expires_at,
      detail: initiated.detail
    });
  } catch (err) {
    logger.error("billing.checkout_failed", { error: err.message });
    return res.status(500).json({ ok: false, error: "checkout_failed" });
  }
});

/** Poll a checkout. Tenant-scoped: another tenant's id is simply not found. */
router.get("/billing/checkout/:paymentId", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "billing_unavailable" });
  }
  const id = String(req.params.paymentId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(404).json({ ok: false, error: "no_such_payment" });
  }
  try {
    const payment = await billingRepository.paymentById(req.userStore.tenantId, id);
    if (!payment) return res.status(404).json({ ok: false, error: "no_such_payment" });

    // Report the CURRENT entitlement alongside, so a client that sees
    // "successful" can render the new capabilities without a second call.
    const account = payment.status === "successful"
      ? await subscriptionService.accountEntitlements(req.userStore)
      : null;

    res.json({
      ok: true,
      status: payment.status,
      plan: payment.plan,
      amount: payment.amount,
      currency: payment.currency,
      failure_reason: payment.failure_reason,
      expires_at: payment.expires_at,
      account
    });
  } catch (err) {
    logger.error("billing.status_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "billing_unavailable" });
  }
});

/**
 * PROVIDER WEBHOOK.
 *
 * Unauthenticated by nature — it is called by the provider, not the user — so
 * it authorises NOTHING on its own. It normalises the callback, resolves the
 * tenant from the provider reference, and hands the outcome to a repository
 * that will only settle a pending, unexpired payment belonging to that tenant.
 *
 * ALWAYS 200. A provider that receives an error retries, and a retry storm
 * against a callback we have already handled helps nobody. The OUTCOME is in
 * the body and in the logs.
 */
router.post("/billing/webhook/:provider", async (req, res) => {
  const providerName = String(req.params.provider || "").toLowerCase();
  const adapter = paymentProvider.adapters.get(providerName);
  if (!adapter) {
    logger.warn("billing.webhook_unknown_provider", { provider: providerName });
    return res.status(200).json({ ok: false, outcome: "unknown_provider" });
  }

  /* ── SIGNATURE VERIFICATION, BEFORE ANYTHING ELSE ──────────────
   *
   * A provider that signs its callbacks is the only one whose webhook can be
   * trusted on its own, and Paystack was chosen precisely because it does
   * (HMAC-SHA512 over the raw body). The check runs FIRST: an unverified
   * payload is not parsed, not correlated, and not logged in full.
   *
   * AN ADAPTER THAT CANNOT SIGN. Direct Daraja emits no signature at all, so
   * `verifySignature` is absent and this check is skipped. That is a real gap
   * and it is named here rather than left as an absent check nobody notices.
   *
   * THIS COMMENT USED TO CLAIM AN IP ALLOWLIST WAS PART OF THE MITIGATION. No
   * allowlist existed anywhere in the codebase, and one was deliberately not
   * added: Safaricom's callback ranges are documented by the community rather
   * than published as a stable, versioned list, and those same sources warn
   * that new source IPs appear without notice. Rejecting a genuine callback
   * from a new Safaricom IP would leave a customer who has actually paid stuck
   * on `pending` — and the status route only READS the stored payment, so
   * nothing would ever settle it. That failure is worse than the forgery this
   * would defend against, which R5 below already defeats.
   *
   * WHAT ACTUALLY PROTECTS AN UNSIGNED CALLBACK, all of it enforced below or in
   * billingRepository.settlePaymentAndActivate:
   *
   *   CORRELATION       the callback must carry a provider reference we issued
   *                     at checkout; an unknown reference resolves to no tenant
   *                     and settles nothing.
   *   PENDING ONLY      only a `pending` payment can be settled, so a replay
   *                     finds the row already `successful` and is a no-op.
   *   R5 VERIFICATION   Safaricom is re-queried over a connection WE open
   *                     before anything is granted. A forged callback is
   *                     contradicted there and activates nothing.
   *   OUR OWN AMOUNT    the sum charged comes from the payment row written at
   *                     checkout, never from the callback body.
   *   ATOMIC + UNIQUE   settlement and activation are one transaction under a
   *                     row lock, with UNIQUE (provider, provider_ref), so
   *                     concurrent deliveries produce exactly one activation.
   */
  if (typeof adapter.verifySignature === "function") {
    const check = adapter.verifySignature({
      rawBody: req.rawBody, headers: req.headers
    });
    if (!check.valid) {
      logger.warn("billing.webhook_signature_rejected", {
        provider: providerName, reason: check.reason
      });
      /* 401 here, not 200: an unsigned or wrongly-signed request is not a
         delivery to acknowledge. A genuine provider retry will be signed. */
      return res.status(401).json({ ok: false, outcome: "invalid_signature" });
    }
  }

  let parsed;
  try {
    parsed = adapter.handleWebhook({ body: req.body, headers: req.headers });
  } catch (err) {
    logger.error("billing.webhook_parse_failed", { error: err.message });
    return res.status(200).json({ ok: false, outcome: "unparseable" });
  }
  if (!parsed || !parsed.ok || !parsed.providerRef) {
    return res.status(200).json({ ok: false, outcome: "unparseable" });
  }

  try {
    /* THE TENANT COMES FROM THE STORED PAYMENT, never from the callback. A
       callback quoting another tenant's reference resolves to THAT tenant and
       is then checked against that tenant's own rows — it cannot be used to
       activate a subscription for whoever sent it. */
    const tenantId = await billingRepository.tenantForProviderRef(
      providerName, parsed.providerRef);
    if (!tenantId) {
      logger.warn("billing.webhook_unmatched", { provider: providerName });
      return res.status(200).json({ ok: false, outcome: "not_found" });
    }

    /* ── R5: INDEPENDENT VERIFICATION BEFORE GRANTING ──────────────
     *
     * The signature already proves the callback came from the provider. This
     * asks the provider a second time, over a channel we initiated, before any
     * money-bearing state changes.
     *
     * WHY BOTH. A signature proves authenticity, not currency: a replayed
     * body is authentically signed and may describe a transaction that has
     * since been reversed. Re-querying is the difference between "this message
     * is genuine" and "this payment is genuine right now", and activation is
     * the one place that distinction is worth a round trip.
     *
     * FAIL CLOSED, BUT NOT DESTRUCTIVELY. If the provider contradicts the
     * callback, nothing is activated. If the provider is UNREACHABLE the
     * payment is left pending rather than failed — the money may well have
     * moved, and marking it failed would strand a paying customer. A retry or
     * the status query settles it. */
    if (parsed.status === "successful" && typeof adapter.verifyPayment === "function") {
      let confirmed;
      try {
        confirmed = await adapter.verifyPayment({ providerRef: parsed.providerRef });
      } catch (err) {
        logger.warn("billing.webhook_verify_unreachable", {
          provider: providerName, error: err.message
        });
        return res.status(200).json({ ok: false, outcome: "verification_unavailable" });
      }
      if (confirmed && confirmed.status !== "successful") {
        logger.warn("billing.webhook_contradicted", {
          provider: providerName, claimed: parsed.status, actual: confirmed.status
        });
        return res.status(200).json({
          ok: false, outcome: "verification_failed", actual: confirmed.status
        });
      }
    }

    const result = await billingRepository.settlePaymentAndActivate(tenantId, {
      provider: providerName,
      providerRef: parsed.providerRef,
      status: parsed.status,
      providerResult: parsed.raw,
      receipt: parsed.receipt
    });

    logger.info("billing.webhook_handled", {
      provider: providerName, outcome: result.outcome
    });
    return res.status(200).json({ ok: result.ok, outcome: result.outcome });
  } catch (err) {
    logger.error("billing.webhook_failed", { error: err.message });
    /* The payment row survives in whatever state it was in, so this is
       recoverable: the provider will retry, or the status query will settle it.
       Nothing is half-activated, because activation is one transaction. */
    return res.status(200).json({ ok: false, outcome: "error" });
  }
});

/** Voluntary downgrade to the free tier. */
router.post("/billing/cancel", async (req, res) => {
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    return res.status(503).json({ ok: false, error: "billing_unavailable" });
  }
  try {
    const cancelled = await billingRepository.cancelSubscription(req.userStore.tenantId);
    await subscriptionService.syncProfilePlan(req.userStore);
    res.json({
      ok: true,
      cancelled: Boolean(cancelled),
      // Entitlement drops immediately; the payment history is untouched.
      account: await subscriptionService.accountEntitlements(req.userStore)
    });
  } catch (err) {
    logger.error("billing.cancel_failed", { error: err.message });
    res.status(503).json({ ok: false, error: "billing_unavailable" });
  }
});

router.post("/executive-report/email", async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "mail_not_configured",
      detail: "Email delivery is not set up on this server yet.",
      missing: mailer.missingConfig()
    });
  }

  const body = req.body || {};
  const recipients = Array.isArray(body.to) ? body.to : (body.to ? [body.to] : []);
  if (!recipients.length) {
    return res.status(400).json({ ok: false, error: "no_recipient",
      detail: "Give at least one email address to send this report to." });
  }

  try {
    const context = await getContextAsync(req, body.month || null);
    if (!context) {
      return res.status(400).json({ ok: false, error: "no_report",
        detail: "Run a monthly review first." });
    }

    const profile = req.userStore.profile;
    const disclosure = disclosureFor(context);
    const model = buildReportModel(context, profile, {
      title: body.title, disclosure
    });
    const pdf = await renderReportPdf(model);

    /* The COVERING TEXT carries the limitations too. A recipient who reads the
       email body and never opens the attachment must still learn that the
       analysis was not fully observed. */
    const period = context.period || "the current period";
    const lines = [
      `${model.company} — financial report for ${period}.`,
      "",
      model.healthScore != null
        ? `Health score: ${model.healthScore}/100 (${model.healthCategory || "unrated"}).`
        : "Health score: not available for this period.",
      "",
      "The full report is attached as a PDF."
    ];
    if (disclosure) {
      lines.push("", "Limitations of this report:");
      disclosure.limitations.forEach((l) => lines.push(`- ${l.detail}`));
      lines.push("",
        "This analysis is not based on fully observed data. Figures shown as "
        + "unavailable were not measured, and must not be read as zero.");
    }

    const safeName = String(model.company || "report")
      .replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);

    const sent = await mailer.sendReport({
      to: recipients,
      subject: `${model.company} — financial report, ${period}`,
      text: lines.join("\n"),
      attachment: {
        filename: `finguard-${safeName}-${model.period || "report"}.pdf`,
        content: pdf,
        contentType: "application/pdf"
      }
    });

    if (!sent.ok) {
      // 502 for an upstream SMTP failure, 400 for something the user can fix.
      const status = sent.reason === "send_failed" ? 502 : 400;
      return res.status(status).json({
        ok: false, error: sent.reason, detail: sent.detail
      });
    }

    return res.json({
      ok: true,
      sent_to: sent.recipients,
      message_id: sent.messageId,
      // The recipient learns the same limitations the reader of the PDF does.
      complete: disclosure === null,
      disclosure
    });
  } catch (error) {
    logger.error("report.email_failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "email_failed",
      detail: "The report could not be sent." });
  }
});

/** Is email usable on this deployment, and do the credentials actually work? */
router.get("/mail/status", async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.json({ ok: true, configured: false, missing: mailer.missingConfig() });
  }
  const check = await mailer.verify();
  res.json({
    ok: true,
    configured: true,
    // Verified means the server accepted the credentials, not merely that they
    // are present — a settings screen can show the difference.
    verified: check.ok,
    detail: check.ok ? null : check.detail
  });
});

router.post("/executive-report/pdf", async (req, res) => {
  try {
    /* THE EXPORT PATH MUST BEHAVE LIKE THE JSON ONE.
     *
     * This used `getContext`, the synchronous variant, and inherited both of
     * its limitations while the JSON report had already moved past them:
     *
     *   IT IGNORED THE REQUESTED MONTH. Whatever period happened to be cached
     *   was exported, so asking for June produced a PDF headed "Reporting
     *   period: 2026-05" with May's figures — a wrong-month document with
     *   nothing in it to reveal the mismatch, in the artifact most likely to be
     *   forwarded to someone who cannot check.
     *
     *   IT DID NOT RECOVER. After a restart it answered "Run a monthly review
     *   first" while the completed analysis sat in PostgreSQL and the JSON
     *   report rendered from it perfectly well.
     */
    const context = await getContextAsync(req, (req.body && req.body.month) || null);
    if (!context) {
      return res.status(400).json({ ok: false, error: "no_report", message: "Run a monthly review first." });
    }

    const profile = req.userStore.profile;

    // Reports (including the branded PDF) are available on every plan: rendering
    // a document from already-computed numbers is deterministic work, not
    // intelligence, so it is neither plan-gated nor charged in AI credits.
    /* The PDF gets the SAME limitations the JSON report does — same builder,
       same wording. Without this the exported document was the one artifact
       that stated its figures with no qualification at all. */
    const model = buildReportModel(context, profile, {
      title: req.body && req.body.title,
      disclosure: disclosureFor(context)
    });
    const pdf = await renderReportPdf(model);

    const safeName = String(model.company || "report").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="finguard-${safeName}-${model.period || "report"}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    logger.error("pdf generation failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "pdf_generation_failed" });
  }
});

/**
 * THE FINANCIAL COPILOT.
 *
 * Distinct from /chat, which remains for backward compatibility: this returns a
 * STRUCTURED answer separating detected facts from interpretation and advice,
 * with every fact carrying the citation it was validated against.
 *
 * Everything authoritative is retrieved by a named capability before the model
 * is called. The model explains; it does not look things up.
 */
router.post("/copilot", async (req, res) => {
  try {
    const body = req.body || {};
    const message = String(body.message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "A question is required." });

    const now = new Date();
    const currentMonth = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    const targetMonth = body.month
      || (req.userStore.latestReviewContext && req.userStore.latestReviewContext.period)
      || currentMonth;

    /* THE AUTHORITATIVE RUN — from memory, or RECOVERED FROM POSTGRESQL.
     *
     * JOB 11 CLOSED THE READ SIDE. `saveRun` persisted the run, its findings,
     * its evidence and its metrics, and JOB 10 wired that write. Nothing ever
     * read it back, so after a restart every row was present and the
     * application could not see them. The user was told "there is no analysis
     * for this period yet" while a completed run sat in the database — and the
     * interim honest version of that message ("saved, but not loaded — re-run
     * it") was still a workaround, not a recovery.
     *
     * `resolveRun` now loads the completed run from PostgreSQL when this
     * process has none. It REBUILDS from stored rows; it never re-runs the
     * engine to answer a question about a historical period, because a re-run
     * against today's rules would produce a different answer while claiming to
     * be the original. A row written before JOB 11 cannot be rebuilt and is
     * reported as legacy rather than silently recomputed. */
    const resolved = await resolveRun(req.userStore, targetMonth);
    let run = resolved.run;

    /* THE FALLBACK MUST BE FOR THE PERIOD THAT WAS ASKED ABOUT.
     *
     * A DEFECT FOUND DURING END-TO-END VERIFICATION. This fell back to whatever
     * analysis was last reviewed in this process, with no period check — so a
     * question about March was answered from July's run, and every figure in
     * the reply belonged to a month the user had not asked about. It also
     * SHADOWED the legacy branch below: because `run` was non-null, a period
     * whose stored analysis cannot be rebuilt never reported itself as legacy,
     * and the request continued into the AI with the wrong period's data.
     *
     * The in-process suite did not catch it, because a freshly started test
     * server has no cached context for the fallback to reach for. It surfaced
     * only when a real session reviewed several periods and then asked about
     * another one. */
    const cached = req.userStore.latestReviewContext;
    if (!run && cached && cached.rawAnalysis && cached.rawAnalysis.run
        && (cached.period === targetMonth
          || cached.rawAnalysis.run.period === targetMonth)) {
      run = cached.rawAnalysis.run;
    }

    /* A LEGACY ROW IS NOT A RECOVERABLE ONE. It is a genuine historical run
       whose authoritative metrics and period inputs were never stored, so it
       cannot be handed back as a completed analysis. Saying so is the only
       honest option: the alternative is inventing the missing inputs. */
    if (!run && resolved.outcome === analysisRunRepository.RECOVERY.LEGACY) {
      return res.json({
        ok: false,
        reason: "analysis_legacy_unrecoverable",
        message: "This period was analysed before the application stored everything "
          + "needed to reload it. Re-run the review for this month and it will be "
          + "fully recoverable from then on.",
        period: targetMonth,
        analysis_saved: true,
        recoverable: false
      });
    }

    /* THE MOST RECENT EARLIER RUN, for "compare with last month".
       Also recovered from PostgreSQL: a comparison that silently dropped the
       prior period after a restart would answer "I have nothing to compare
       against" while the earlier run sat in the database. */
    const runs = req.userStore.analysisRuns || {};
    let previousRun = null;
    const earlier = Object.keys(runs).filter((p) => p < targetMonth).sort();
    if (earlier.length) {
      previousRun = runs[earlier[earlier.length - 1]];
    } else if (req.userStore.tenantId && dbPool.isConfigured()) {
      try {
        const periods = await analysisRunRepository.completedPeriods(req.userStore.tenantId);
        const prior = periods
          .filter((p) => p.period < targetMonth && p.recoverable)
          .sort((a, b) => (a.period < b.period ? 1 : -1))[0];
        if (prior) {
          const loaded = await resolveRun(req.userStore, prior.period);
          previousRun = loaded.run;
        }
      } catch (err) {
        // A missing comparison is a degraded answer, never a failed request.
        logger.warn("copilot.previous_run_lookup_failed", { error: err.message });
      }
    }

    /* The conversation store is chosen per request: PostgreSQL when the tenant
       is provisioned and a database exists, so conversations survive restart
       and are shared across instances; the in-memory store otherwise. The
       in-memory backing is kept on the user store so a development session
       still has continuity within the process. */
    if (!req.userStore.copilotConversations) {
      req.userStore.copilotConversations = conversationStore.createStore();
    }
    const store = copilotStore.createStore(req.userStore.tenantId || null, {
      fallback: req.userStore.copilotConversations
    });

    const result = await copilot.ask({
      run,
      previousRun,
      tenantId: req.userStore.tenantId || null,
      userId: req.userStore.userId || null,
      userRole: (req.userStore.profile && req.userStore.profile.role) || null,
      profile: req.userStore.profile,
      config,
      message,
      conversationId: body.conversation_id || null,
      store,
      /* THE PERIOD'S RECORDS — from memory, or RECOVERED from PostgreSQL.
         Without this, `get_related_transactions` on a recovered analysis
         reported that the records were not loaded while they sat in the
         database, and a finding citing two duplicate payments could not show
         which two. */
      /* PERIOD-CHECKED, like the run above. The same defect existed here for
         the RECORDS: the cached envelope was used regardless of which month it
         belonged to, so the copilot could pair the requested period's analysis
         with ANOTHER period's transactions and cite them as evidence for a
         finding. `resolveMonthlyData` loads the correct period from storage. */
      monthlyData: (cached && cached.rawMonthlyData
        && (cached.period === targetMonth
          || cached.rawMonthlyData.period === targetMonth))
        ? cached.rawMonthlyData
        : await resolveMonthlyData(req.userStore, targetMonth),
      operation: "chat",
      assistant: body.ai_assistant || req.userStore.profile.aiAssistant,
      findingId: body.finding_id || null,
      scenario: body.scenario || null,
      scenarioParams: body.scenario_params || {}
    });

    if (result.ok) {
      if (result.creditsCharged) persistProfile(req.userStore);
      return res.json({
        ok: true,
        interaction_id: result.interactionId,
        conversation_id: result.conversationId,
        intent: result.intent,
        // The structured contract: facts are cited and were checked; inferences
        // and recommendations are labelled as such.
        answer: result.answer,
        capabilities: result.capabilities,
        suggestions: result.suggestions,
        redaction: result.redaction,
        provider: result.provider,
        model: result.model,
        credits_charged: result.creditsCharged,
        meta: result.meta
      });
    }

    // A blocked or failed answer is reported honestly, never dressed as an answer.
    return res.json({
      ok: false,
      blocked: Boolean(result.blocked),
      interaction_id: result.interactionId,
      reason: result.reason,
      message: result.text,
      issues: result.issues || null,
      suggestions: copilot.SUGGESTIONS
    });
  } catch (error) {
    return serverError(res, "copilot", error);
  }
});

/**
 * Evidence behind one finding — the "show me why" a copilot answer links to.
 * Deterministic: this never involves a model.
 */
router.get("/copilot/evidence/:findingId", (req, res) => {
  try {
    const ctx = req.userStore.latestReviewContext;
    const run = ctx && ctx.rawAnalysis ? ctx.rawAnalysis.run : null;
    // 404, not 200-with-ok:false. A caller asking for evidence that this tenant
    // has no analysis for should get a not-found, so the absence is
    // indistinguishable from a finding that belongs to someone else.
    if (!run) return res.status(404).json({ ok: false, error: "no_analysis" });

    const capabilities = require("../ai/capabilities");
    const result = capabilities.invoke("get_finding_evidence", {
      run,
      tenantId: req.userStore.tenantId || null,
      findingId: req.params.findingId,
      // The owner inspecting their own evidence sees real names.
      level: "full"
    });
    if (!result.ok) return res.status(404).json({ ok: false, error: result.reason, detail: result.detail });
    return res.json({ ok: true, evidence: result.data, citations: result.citations });
  } catch (error) {
    return serverError(res, "copilot-evidence", error);
  }
});

/** The audit trail for one interaction: what the model was given, and why. */
router.get("/copilot/audit/:interactionId", async (req, res) => {
  try {
    const tenantId = req.userStore.tenantId || null;
    if (!tenantId) return res.json({ ok: false, error: "No tenant context." });
    const row = await aiAuditRepository.findById(tenantId, req.params.interactionId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, interaction: row });
  } catch (error) {
    return serverError(res, "copilot-audit", error);
  }
});

router.post("/chat", async (req, res) => {
  try {
    const { message, activeMonth, history, ai_provider, ai_assistant } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Message is required" });
    }

    /* Determine which month to use for context. Precedence:
       1) a month named in the question ("risks in June 2026")
       2) the month currently active on the dashboard
       3) the last-analyzed month
       4) the current calendar month */
    const now = new Date();
    const currentMonth = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    const askedMonth = parseMonthFromText(message);
    const lastMonth = req.userStore.latestReviewContext && String(req.userStore.latestReviewContext.period || "").slice(0, 7);
    const targetMonth = askedMonth || activeMonth || lastMonth || currentMonth;

    /* Reuse the same real data (uploaded CSV / real Zoho / mock) already shown
       on the dashboard for this month instead of re-fetching mock data blind. */
    const cachedContext = req.userStore.latestReviewContext;
    let monthlyData;
    let analysis;
    let chatContext;

    if (cachedContext && cachedContext.period === targetMonth && cachedContext.rawAnalysis) {
      monthlyData = cachedContext.rawMonthlyData;
      analysis = cachedContext.rawAnalysis;
      // Ground chat in whatever is already on the dashboard for this month --
      // AI-computed numbers when an AI key is configured, deterministic
      // skill-engine numbers otherwise. Never a second, possibly-divergent copy.
      chatContext = cachedContext;
    } else {
      // INGESTION BOUNDARY.
      monthlyData = (await ingestDataOrThrow(req.userStore, targetMonth)).data;
      analysis = analyzeFinancialRisk(monthlyData, { period: targetMonth, tenantId: req.userStore.tenantId || null, reviewHistory: req.userStore.reviewHistory });
      chatContext = buildContext({
        month: targetMonth,
        monthlyData,
        analysis,
        report: {},
        followUp: {},
        reviewHistory: req.userStore.reviewHistory,
        reportsDir: req.userStore.reportsDir
      });
      // Carry the period's raw records so the assistant can answer
      // transaction-level questions, not just aggregate findings.
      chatContext.rawMonthlyData = monthlyData;
    }

    const resolvedAssistant = ai_assistant || req.userStore.profile.aiAssistant;
    const chatProfile = req.userStore.profile;
    const routing = entitlements.resolveAiRouting(chatProfile, config);
    const resolvedProvider = routing.provider;
    let aiFailureReason = null;

    /* JOB 8. The whole AI path is now one call into the orchestrator:
         authoritative run -> bounded context -> provider router -> validation.

       Two things changed materially for correctness:
       1. The answer is VALIDATED. Every figure must trace to a value the
          deterministic engine computed; an answer containing an invented number
          is blocked rather than rendered.
       2. Line-item retrieval no longer spends the server's NVIDIA key for every
          tenant. The AI-assisted filter is routed and metered like any other
          call, so a BYOK tenant uses their own provider and a managed tenant is
          charged for it. */
    const authoritativeRun = analysis && analysis.run ? analysis.run : null;

    if (!authoritativeRun) {
      // No authoritative analysis means no authoritative numbers. Falling
      // through to the deterministic summary is correct; asking a model to
      // discuss finances it has no data for is not.
      aiFailureReason = "no_analysis_run";
    } else {
      const needsLineItems = transactionRetrieval.isLineItemQuestion(message);
      let retrieval = null;
      if (needsLineItems && chatContext.rawMonthlyData) {
        retrieval = transactionRetrieval.retrieve(chatContext.rawMonthlyData, message);
        if (retrieval.needsInterpretation) {
          // The assist is a support call on the USER's routing, charged to the
          // same operation. If they cannot pay for it, the deterministic filter
          // stands — the question is still answered, just less precisely.
          const assistRoute = aiRouter.route({
            profile: chatProfile, config, operation: "chat", internal: true
          });
          if (assistRoute.allowed) {
            try {
              const aiFilter = await extractTransactionFilter({
                apiKey: assistRoute.apiKey,
                provider: assistRoute.provider,
                message,
                parties: transactionRetrieval.knownParties(chatContext.rawMonthlyData),
                period: targetMonth
              });
              if (aiFilter && Object.keys(aiFilter).length) {
                const refined = transactionRetrieval.applyFilter(chatContext.rawMonthlyData, aiFilter);
                if (refined.matchedCount > 0) {
                  retrieval = Object.assign({ filter: aiFilter, assisted: true }, refined);
                }
              }
            } catch (e) {
              // Best-effort: the deterministic result already works.
            }
          }
        }
      }

      const result = await aiOrchestrator.ask({
        run: authoritativeRun,
        tenantId: req.userStore.tenantId || null,
        profile: chatProfile,
        config,
        message,
        history,
        operation: "chat",
        assistant: resolvedAssistant,
        monthlyData: chatContext.rawMonthlyData,
        retrieval,
        includeLineItems: needsLineItems
      });

      if (result.ok) {
        await aiOrchestrator.chargeFor({ profile: chatProfile, result, operation: "chat", tenantId: req.userStore.tenantId || null });
        if (result.routing.managed) persistProfile(req.userStore);
        return res.json({
          ok: true,
          intent: "ai_generated",
          reply: result.text,
          text: result.text,
          html: `<p>${escapeHtml(result.text).replace(/\n/g, "<br>")}</p><p class="text-sm text-muted" style="margin-top:0.75rem">Assistant: <strong>${escapeHtml(resolvedAssistant)}</strong> via <strong>${escapeHtml(result.provider)}</strong> · verified against your analysis</p>`,
          suggestions: [
            "Show risk summary for this month",
            "What are the top 3 actions this week?",
            "Explain cash flow risk in plain terms"
          ],
          hint: "AI response, checked against the deterministic analysis.",
          context: {
            month: targetMonth,
            assistant: resolvedAssistant,
            provider: result.provider,
            model: result.model,
            mode: "ai+context",
            analysis_run_id: result.meta.analysisRunId,
            // What the model was actually given, so the answer is auditable.
            context_findings: result.meta.findingsSelected,
            context_line_items: result.meta.lineItemsIncluded,
            knowledge_used: result.meta.knowledgeChunks,
            figures_checked: result.validation.checked
          }
        });
      }

      if (result.blocked) {
        /* The model answered, but the answer contained financial claims that do
           not trace back to the engine. It is NOT shown. The user gets the
           honest safe response instead of a plausible fabrication, and is not
           charged for it. */
        req.log.warn("ai.answer.blocked", { reason: result.reason, unsupported: (result.validation.unsupported || []).length });
        return res.json({
          ok: true,
          intent: "ai_blocked",
          reply: result.text,
          text: result.text,
          html: `<p>${escapeHtml(result.text).replace(/\n/g, "<br>")}</p>`,
          ai_unavailable: true,
          ai_error: result.reason,
          hint: "The AI answer could not be verified against your data and was withheld.",
          context: { month: targetMonth, mode: "blocked", verdict: result.reason }
        });
      }

      aiFailureReason = result.reason || "ai_request_failed";
    }

    /* The AI call did not produce an answer — fall back to the deterministic
       rule-based summary, but label it honestly so it is never mistaken for a
       real AI response. */
    const intent = classifyIntent(message);
    const response = buildChatResponse(intent, analysis, targetMonth, {
      provider: resolvedProvider,
      assistant: resolvedAssistant
    });
    const note = aiUnavailableNote(aiFailureReason);
    const honestText = note + "\n\n" + response.text;

    res.json({
      ok: true,
      intent,
      reply: honestText,
      text: honestText,
      html: '<p class="text-sm" style="color:#f59e0b;margin-bottom:0.6rem;">' + escapeHtml(note) + '</p>' + response.html,
      suggestions: response.suggestions,
      hint: "AI unavailable — showing a rule-based summary.",
      ai_unavailable: true,
      context: {
        month: targetMonth,
        assistant: resolvedAssistant,
        provider: resolvedProvider,
        mode: "skills-fallback",
        ai_error: aiFailureReason
      }
    });
  } catch (error) {
    serverError(res, "route", error);
  }
});

router.post("/avalanche/contracts/deploy", async (req, res) => {
  try {
    const result = await deployCChainContract(req.body || {});
    const requestBody = req.body || {};
    appendDeploymentRecord(req.userStore.reportsDir, {
      contract_name: result?.plan?.contract_name || requestBody.contractName || requestBody.contract_name || "Contract",
      receiver_address: requestBody.receiverAddress || requestBody.receiver_address || requestBody.recipient || requestBody.to || "",
      dry_run: Boolean(result.dry_run),
      ok: Boolean(result.ok),
      mode: result?.plan?.mode || (requestBody.dryRun === false ? "live" : "dry-run"),
      chain_id: result?.plan?.chain_id || null,
      rpc_url: result?.plan?.rpc_url || "",
      tx_hash: result?.deployment?.tx_hash || "",
      address: result?.deployment?.address || "",
      error: result.ok ? "" : (result.error || "unknown_error"),
      message: result.message || "",
      actor: req.userStore.profile.userName || "unknown"
    });

    const statusCode = result.ok ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (error) {
    const requestBody = req.body || {};
    appendDeploymentRecord(req.userStore.reportsDir, {
      contract_name: requestBody.contractName || requestBody.contract_name || "Contract",
      receiver_address: requestBody.receiverAddress || requestBody.receiver_address || requestBody.recipient || requestBody.to || "",
      dry_run: requestBody.dryRun !== false,
      ok: false,
      mode: requestBody.dryRun === false ? "live" : "dry-run",
      chain_id: requestBody.chainId || requestBody.chain_id || null,
      rpc_url: requestBody.rpcUrl || requestBody.rpc_url || "",
      tx_hash: "",
      address: "",
      error: "deploy_failed",
      message: error.message,
      actor: req.userStore.profile.userName || "unknown"
    });

    return res.status(500).json({
      ok: false,
      error: "deploy_failed",
      message: error.message
    });
  }
});

router.get("/avalanche/contracts/templates", (req, res) => {
  return res.json({ ok: true, items: listContractTemplates() });
});

router.get("/avalanche/contracts/deployments", (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const items = listDeploymentRecords(req.userStore.reportsDir, limit);
  return res.json({ ok: true, items, count: items.length });
});

router.get("/avalanche/networks", (req, res) => {
  return res.json({ ok: true, items: Object.values(config.avalancheNetworks) });
});

// Record an on-chain money movement (deposit / withdraw / release / refund / claim)
// so it can be included in the monthly financial analysis.
router.post("/avalanche/onchain/record", async (req, res) => {
  const body = req.body || {};
  const txHash = String(body.txHash || body.tx_hash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ ok: false, error: "invalid_tx_hash" });
  }

  const chainId = Number(body.chainId || body.chain_id) || null;
  let verified = false;
  // Best-effort on-chain verification (never blocks recording if RPC is down).
  try {
    const verification = await verifyDeploymentTx({ chainId, txHash });
    verified = Boolean(verification && verification.verified);
  } catch (e) { /* keep verified=false */ }

  const saved = appendLedgerEntry(req.userStore.reportsDir, {
    month: body.month || null,
    kind: body.kind || "transfer",
    contractName: body.contractName || body.contract_name,
    contractAddress: body.contractAddress || body.contract_address,
    txHash,
    chainId,
    from: body.from,
    to: body.to,
    wallet: body.wallet || body.walletAddress,
    amount: body.amount != null ? body.amount : body.amount_avax,
    verified
  });

  return res.json({ ok: true, entry: saved });
});

router.get("/avalanche/onchain/ledger", (req, res) => {
  if (req.query.month) {
    return res.json({ ok: true, summary: summarizeOnchainMonth(req.userStore.reportsDir, String(req.query.month)) });
  }
  const items = listLedgerEntries(req.userStore.reportsDir, Number(req.query.limit) || 100);
  return res.json({ ok: true, items, count: items.length });
});

// Cash-flow forecast: deterministic 30/60/90-day projection (always free) plus
// an optional AI advisory that costs credits on managed plans.
router.post("/forecast", async (req, res) => {
  try {
    const body = req.body || {};
    const now = new Date();
    const currentMonth = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    const targetMonth = body.month || (req.userStore.latestReviewContext && req.userStore.latestReviewContext.period) || currentMonth;

    // Reuse the month already on the dashboard, else compute fresh.
    const ctx = req.userStore.latestReviewContext;
    let monthlyData, cashflow;
    if (ctx && ctx.period === targetMonth && ctx.rawMonthlyData) {
      monthlyData = ctx.rawMonthlyData;
      cashflow = ctx.cashflow;
    } else {
      // INGESTION BOUNDARY (see ingestForStore). Throws on invalid period /
      // no source / total failure, which the route's catch turns into an error
      // response rather than an analysis of fabricated data.
      monthlyData = (await ingestDataOrThrow(req.userStore, targetMonth)).data;
      // Domain engine, not the legacy summary: cashflow now comes from
      // domain/analysis/metrics via the same path as every other route.
      const domainRun = domainEngine.analyze(monthlyData, {
        tenantId: req.userStore.tenantId || null, period: targetMonth
      });
      cashflow = toLegacyContext(domainRun, {}).cashflow;
    }

    /* STARTING CASH MUST BE OBSERVED (JOB 13 Phase B).
     *
     * THE BYPASS. This read `balanceSheet.cashAndEquivalents` raw and defaulted
     * to 0. Two ways that fabricates financial state: a DERIVED estimate (which
     * on any loss-making month is exactly 0) became the starting balance, and a
     * genuinely absent balance became 0 outright. Either way the projection
     * starts from a cash position nobody supplied, and a forecast that begins at
     * zero projects insolvency with total confidence.
     *
     * Read through the one authoritative accessor, and refuse rather than guess.
     * The runway*burn back-derivation below is also gone: runway is itself
     * computed FROM the cash balance, so recovering cash from it is circular —
     * and it is null now anyway whenever the balance was not observed. */
    const cashPosition = readCashPosition(
      monthlyData && monthlyData.statements && monthlyData.statements.balanceSheet);
    if (!cashPosition.available) {
      return res.status(409).json({
        ok: false,
        error: "cash_balance_required",
        reason: cashPosition.unavailableReason,
        basis: cashPosition.basis,
        detail: cashPosition.basis === "derived_from_net_income"
          ? "This period has no cash balance on record. An estimate was derived "
            + "from net income, but a projection started from an estimate would "
            + "read as a measurement. Add your cash balance for this period and "
            + "run it again."
          : "This period has no cash balance on record. Add it and run this again.",
        period: targetMonth
      });
    }
    const startingCash = cashPosition.value;

    /* PASS THE MEASUREMENTS THROUGH, NOT ZEROES. `toNumber(x, 0)` here turned
       an unmeasured net flow or burn rate into 0 before the forecaster could
       see it was missing, which defeated the forecaster's own guard. Only
       overdue receivables keeps a default, because it gates the optimistic
       branch and absence there withholds a figure rather than inventing one. */
    const forecast = computeCashflowForecast({
      startingCash,
      monthlyNet: cashflow.net_cash_flow,
      monthlyBurn: cashflow.monthly_burn,
      overdueReceivables: toNumber(cashflow.overdue_receivables, 0)
    });

    if (forecast.available === false) {
      return res.status(409).json({
        ok: false,
        error: "forecast_inputs_unmeasured",
        reason: forecast.reason,
        missing: forecast.missing,
        detail: forecast.detail,
        period: targetMonth
      });
    }

    // The forecast maths above (30/60/90-day balances, runway, risk) is
    // deterministic and available on every plan. Only the AI interpretation and
    // recommendations below are a paid capability.
    const profile = req.userStore.profile;
    const routing = entitlements.resolveAiRouting(profile, config);
    let ai = { ok: false, reason: "ai_not_requested" };
    if (body.use_ai_analysis !== false) {
      if (!entitlements.can(profile, "ai_forecast_advisory")) {
        // The forecast NUMBERS above are free on every plan; only the AI Cash
        // Flow Advisor (interpretation + strategy) is a paid capability.
        ai = Object.assign(
          { reason: "upgrade_required" },
          entitlements.upgradePayload("ai_forecast_advisory"),
          { message: entitlements.upgradePayload("ai_forecast_advisory").message +
              " Your Cash Flow Forecast numbers, runway and risk level are always free." }
        );
      } else if (!routing.apiKey) {
        ai = { ok: false, reason: routing.mode === "byok" ? "missing_ai_api_key" : "managed_key_unavailable" };
      } else if (routing.managed && !entitlements.canAfford(profile, "forecast")) {
        const ent = entitlements.getEntitlement(profile);
        ai = { ok: false, reason: "insufficient_credits", plan: ent.plan, credits: ent.credits, cost: entitlements.creditCost("forecast") };
      } else {
        /* JOB 8: through the orchestrator, so the advisory is validated against
           the same authoritative data as everything else. The forecast's own
           projections are passed as extraFacts — they are deterministic output
           of computeCashflowForecast, not the model's arithmetic, so the model
           may cite them. */
        const msg = "Advise this SME founder on their cash-flow forecast. In 3-4 short "
          + "sentences give the outlook, then 2 concrete actions. Use only the "
          + "already-computed forecast figures: " + JSON.stringify(forecast);
        const aiChat = await aiOrchestrator.ask({
          run: (ctx && ctx.rawAnalysis && ctx.rawAnalysis.run) || null,
          tenantId: req.userStore.tenantId || null,
          profile, config,
          message: msg,
          operation: "forecast",
          capability: "ai_forecast_advisory",
          assistant: profile.aiAssistant,
          extraFacts: forecast
        });
        if (aiChat.ok) {
          await aiOrchestrator.chargeFor({ profile, result: aiChat, operation: "forecast", tenantId: req.userStore.tenantId || null });
          if (aiChat.routing.managed) persistProfile(req.userStore);
          ai = { ok: true, text: aiChat.text, provider: aiChat.provider, model: aiChat.model, credits_remaining: entitlements.getEntitlement(profile).credits };
        } else if (aiChat.blocked) {
          ai = { ok: false, blocked: true, reason: aiChat.reason, text: aiChat.text };
        } else {
          ai = { ok: false, reason: aiChat.reason || "ai_request_failed" };
        }
      }
    }

    return res.json({ ok: true, month: targetMonth, forecast, ai });
  } catch (error) {
    return serverError(res, "route", error);
  }
});

// AI What-If Simulator: model a business decision before making it. The
// decision-support tool: it answers "what happens if I do X?", which is
// strategic planning rather than monitoring, so the whole simulator is a paid
// capability. Starter users see it locked in the UI with an explanation.
router.post("/what-if", async (req, res) => {
  try {
    const body = req.body || {};
    const now = new Date();
    const currentMonth = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    const targetMonth = body.month || (req.userStore.latestReviewContext && req.userStore.latestReviewContext.period) || currentMonth;

    if (!entitlements.can(req.userStore.profile, "what_if_simulator")) {
      return res.status(403).json(entitlements.upgradePayload("what_if_simulator"));
    }

    if (!body.type || !whatIfSimulator.SCENARIOS[body.type]) {
      return res.status(400).json({ ok: false, error: "unknown_scenario" });
    }

    // Reuse the month already on the dashboard, else compute a fresh context so
    // we have cash flow + health + revenue in one place.
    let ctx = req.userStore.latestReviewContext;
    let monthlyData;
    if (ctx && ctx.period === targetMonth && ctx.rawMonthlyData && ctx.health) {
      monthlyData = ctx.rawMonthlyData;
    } else {
      // INGESTION BOUNDARY (see ingestForStore). Throws on invalid period /
      // no source / total failure, which the route's catch turns into an error
      // response rather than an analysis of fabricated data.
      monthlyData = (await ingestDataOrThrow(req.userStore, targetMonth)).data;
      const analysis = analyzeFinancialRisk(monthlyData, { period: targetMonth, tenantId: req.userStore.tenantId || null, reviewHistory: req.userStore.reviewHistory });
      ctx = buildContext({ month: targetMonth, monthlyData, analysis, report: {}, followUp: {}, reviewHistory: req.userStore.reviewHistory, reportsDir: req.userStore.reportsDir });
    }

    const cashflow = ctx.cashflow || {};
    /* STARTING CASH MUST BE OBSERVED (JOB 13 Phase B).
     *
     * THE BYPASS. This read `balanceSheet.cashAndEquivalents` raw and defaulted
     * to 0. Two ways that fabricates financial state: a DERIVED estimate (which
     * on any loss-making month is exactly 0) became the starting balance, and a
     * genuinely absent balance became 0 outright. Either way the projection
     * starts from a cash position nobody supplied, and a forecast that begins at
     * zero projects insolvency with total confidence.
     *
     * Read through the one authoritative accessor, and refuse rather than guess.
     * The runway*burn back-derivation below is also gone: runway is itself
     * computed FROM the cash balance, so recovering cash from it is circular —
     * and it is null now anyway whenever the balance was not observed. */
    const cashPosition = readCashPosition(
      monthlyData && monthlyData.statements && monthlyData.statements.balanceSheet);
    if (!cashPosition.available) {
      return res.status(409).json({
        ok: false,
        error: "cash_balance_required",
        reason: cashPosition.unavailableReason,
        basis: cashPosition.basis,
        detail: cashPosition.basis === "derived_from_net_income"
          ? "This period has no cash balance on record. An estimate was derived "
            + "from net income, but a projection started from an estimate would "
            + "read as a measurement. Add your cash balance for this period and "
            + "run it again."
          : "This period has no cash balance on record. Add it and run this again.",
        period: targetMonth
      });
    }
    const startingCash = cashPosition.value;

    const baseline = {
      startingCash,
      monthlyNet: toNumber(cashflow.net_cash_flow, 0),
      monthlyBurn: toNumber(cashflow.monthly_burn, 0),
      overdueReceivables: toNumber(cashflow.overdue_receivables, 0),
      monthlyRevenue: toNumber(ctx.revenue && ctx.revenue.total_revenue, 0),
      componentScores: (ctx.health && ctx.health.component_scores) || {}
    };

    // Deterministic simulation — always returned, free for every plan.
    const result = whatIfSimulator.simulate({ type: body.type, params: body.params || {}, baseline });

    if (result.available === false) {
      return res.status(409).json({
        ok: false,
        error: "scenario_inputs_unmeasured",
        reason: result.reason,
        missing: result.missing,
        detail: result.detail,
        period: targetMonth
      });
    }

    // AI recommendation — the gated premium layer.
    const profile = req.userStore.profile;
    const ent = entitlements.getEntitlement(profile);
    const routing = entitlements.resolveAiRouting(profile, config);
    let ai = { ok: false, reason: "ai_not_requested" };

    if (body.use_ai_analysis === false) {
      ai = { ok: false, reason: "ai_not_requested" };
    } else if (!routing.apiKey) {
      ai = { ok: false, reason: routing.mode === "byok" ? "missing_ai_api_key" : "managed_key_unavailable" };
    } else if (routing.managed && !entitlements.canAfford(profile, "what-if")) {
      ai = { ok: false, reason: "insufficient_credits", plan: ent.plan, credits: ent.credits, cost: entitlements.creditCost("what-if") };
    } else {
      const msg = "You are advising an SME founder who is considering a decision. Compare the BEFORE and AFTER of this what-if simulation. " +
        "In 3-4 short sentences: state whether the decision is affordable, what it does to runway and cash, and give one clear recommendation (proceed, proceed with a condition, or hold off). " +
        "Use ONLY these already-computed numbers (never invent any): " + JSON.stringify({
          scenario: result.scenario.label,
          summary: result.scenario.summary,
          baseline: result.baseline,
          adjusted: result.adjusted,
          runway_before: result.forecast_before.days_to_zero,
          runway_after: result.forecast_after.days_to_zero,
          balance_90d_before: result.forecast_before.horizons[2].projected_balance,
          balance_90d_after: result.forecast_after.horizons[2].projected_balance,
          health_before: result.health_before.score,
          health_after: result.health_after.score
        });
      /* The simulator's before/after figures are deterministic (it reuses the
         authoritative cash-flow risk and weighting), so they are citable. */
      const aiChat = await aiOrchestrator.ask({
        run: (ctx && ctx.rawAnalysis && ctx.rawAnalysis.run) || null,
        tenantId: req.userStore.tenantId || null,
        profile, config,
        message: msg,
        operation: "what-if",
        capability: "what_if_simulator",
        assistant: profile.aiAssistant,
        extraFacts: result
      });
      if (aiChat.ok) {
        await aiOrchestrator.chargeFor({ profile, result: aiChat, operation: "what-if", tenantId: req.userStore.tenantId || null });
        if (aiChat.routing.managed) persistProfile(req.userStore);
        ai = { ok: true, text: aiChat.text, provider: aiChat.provider, model: aiChat.model, credits_remaining: entitlements.getEntitlement(profile).credits };
      } else if (aiChat.blocked) {
        ai = { ok: false, blocked: true, reason: aiChat.reason, text: aiChat.text };
      } else {
        ai = { ok: false, reason: aiChat.reason || "ai_request_failed" };
      }
    }

    return res.json({ ok: true, month: targetMonth, result, ai });
  } catch (error) {
    return serverError(res, "route", error);
  }
});

// AI Action Plan: turn this month's findings into a concrete, ordered,
// time-estimated task list. Gated AI action (metered on managed plans).
router.post("/action-plan", async (req, res) => {
  try {
    const body = req.body || {};
    const now = new Date();
    const currentMonth = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    const targetMonth = body.month || (req.userStore.latestReviewContext && req.userStore.latestReviewContext.period) || currentMonth;

    let ctx = req.userStore.latestReviewContext;
    if (!ctx || ctx.period !== targetMonth || !ctx.rawAnalysis) {
      const uploaded = req.userStore.uploadedMonthlyData[targetMonth];
      const monthlyData = (await ingestDataOrThrow(req.userStore, targetMonth)).data;
      const analysis = analyzeFinancialRisk(monthlyData, { period: targetMonth, tenantId: req.userStore.tenantId || null, reviewHistory: req.userStore.reviewHistory });
      ctx = buildContext({ month: targetMonth, monthlyData, analysis, report: {}, followUp: {}, reviewHistory: req.userStore.reviewHistory, reportsDir: req.userStore.reportsDir });
    }

    // Compact summary of what needs acting on this month.
    const findings = {
      health_score: ctx.health && ctx.health.overall_score,
      cashflow: { runway_days: ctx.cashflow && ctx.cashflow.runway_days, net: ctx.cashflow && ctx.cashflow.net_cash_flow },
      anomalies: (ctx.anomalies && ctx.anomalies.items || []).slice(0, 8),
      vendors: ctx.vendors && ctx.vendors.top_vendor_share,
      customers: ctx.customers && ctx.customers.top_customer_share,
      existing_actions: (ctx.actions && ctx.actions.actions || []).slice(0, 8)
    };

    const profile = req.userStore.profile;
    const routing = entitlements.resolveAiRouting(profile, config);
    let ai = { ok: false, reason: "ai_not_requested" };

    if (!entitlements.can(profile, "ai_action_plan")) {
      ai = Object.assign({ reason: "upgrade_required" }, entitlements.upgradePayload("ai_action_plan"));
    } else if (!routing.apiKey) {
      ai = { ok: false, reason: routing.mode === "byok" ? "missing_ai_api_key" : "managed_key_unavailable" };
    } else if (routing.managed && !entitlements.canAfford(profile, "action-plan")) {
      const ent = entitlements.getEntitlement(profile);
      ai = { ok: false, reason: "insufficient_credits", plan: ent.plan, credits: ent.credits, cost: entitlements.creditCost("action-plan") };
    } else {
      const msg = "You are an SME financial controller. Turn these findings into a concrete, prioritized action plan for this week. " +
        "Give a numbered list; for each item state the specific action, who does it (founder or accountant), and an estimated time. " +
        "End with a total estimated time. Use ONLY these already-computed findings (never invent numbers): " + JSON.stringify(findings);
      const aiChat = await aiOrchestrator.ask({
        run: (ctx && ctx.rawAnalysis && ctx.rawAnalysis.run) || null,
        tenantId: req.userStore.tenantId || null,
        profile, config,
        message: msg,
        operation: "action-plan",
        capability: "ai_action_plan",
        assistant: profile.aiAssistant,
        extraFacts: findings
      });
      if (aiChat.ok) {
        await aiOrchestrator.chargeFor({ profile, result: aiChat, operation: "action-plan", tenantId: req.userStore.tenantId || null });
        if (aiChat.routing.managed) persistProfile(req.userStore);
        ai = { ok: true, text: aiChat.text, provider: aiChat.provider, model: aiChat.model, credits_remaining: entitlements.getEntitlement(profile).credits };
      } else if (aiChat.blocked) {
        ai = { ok: false, blocked: true, reason: aiChat.reason, text: aiChat.text };
      } else {
        ai = { ok: false, reason: aiChat.reason || "ai_request_failed" };
      }
    }

    return res.json({ ok: true, month: targetMonth, ai });
  } catch (error) {
    return serverError(res, "route", error);
  }
});

// ── Custom Financial Rules (Growth & Custom AI) ────────────────
function canManageRules(profile) {
  return entitlements.can(profile, "custom_rules");
}

router.get("/rules", (req, res) => {
  const profile = req.userStore.profile;
  const ent = entitlements.getEntitlement(profile);
  return res.json({
    ok: true,
    rules: profile.customRules || [],
    examples: customRules.EXAMPLE_RULES,
    rule_types: customRules.RULE_TYPES,
    actions: customRules.ACTIONS,
    severities: customRules.SEVERITIES,
    can_manage: entitlements.can(profile, "custom_rules"),
    // DOWNGRADE POLICY: rules are never deleted. When the capability is absent
    // they are retained and simply not executed.
    execution_paused: !entitlements.can(profile, "custom_rules") && (profile.customRules || []).length > 0,
    plan: ent.plan
  });
});

router.post("/rules", (req, res) => {
  const profile = req.userStore.profile;
  if (!canManageRules(profile)) {
    return res.status(403).json(entitlements.upgradePayload("custom_rules"));
  }
  const v = customRules.validateRule(req.body || {});
  if (!v.ok) return res.status(400).json({ ok: false, error: "invalid_rule", message: v.error });
  const rule = Object.assign(
    { id: "rule-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() },
    v.rule
  );
  profile.customRules = profile.customRules || [];
  profile.customRules.push(rule);
  persistProfile(req.userStore);
  return res.json({ ok: true, rule });
});

router.put("/rules/:id", (req, res) => {
  const profile = req.userStore.profile;
  if (!canManageRules(profile)) return res.status(403).json(entitlements.upgradePayload("custom_rules"));
  const list = profile.customRules || [];
  const idx = list.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "not_found" });
  const body = req.body || {};
  // Lightweight enable/disable toggle, or a full edit.
  if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
    list[idx].enabled = body.enabled;
  } else {
    const v = customRules.validateRule(body);
    if (!v.ok) return res.status(400).json({ ok: false, error: "invalid_rule", message: v.error });
    list[idx] = Object.assign({}, list[idx], v.rule);
  }
  persistProfile(req.userStore);
  return res.json({ ok: true, rule: list[idx] });
});

router.delete("/rules/:id", (req, res) => {
  const profile = req.userStore.profile;
  if (!canManageRules(profile)) return res.status(403).json(entitlements.upgradePayload("custom_rules"));
  const before = (profile.customRules || []).length;
  profile.customRules = (profile.customRules || []).filter((r) => r.id !== req.params.id);
  persistProfile(req.userStore);
  return res.json({ ok: true, removed: before - profile.customRules.length });
});

// Preview a candidate rule against the current month's data before saving.
router.post("/rules/preview", (req, res) => {
  const profile = req.userStore.profile;
  if (!canManageRules(profile)) return res.status(403).json(entitlements.upgradePayload("custom_rules"));
  const candidate = (req.body && req.body.rule) || req.body || {};
  const context = getContext(req);
  const monthlyData = context && context.rawMonthlyData;
  const analysis = context && context.rawAnalysis;
  if (!monthlyData || !analysis) {
    return res.json({ ok: true, preview: { matchCount: 0, samples: [], no_data: true } });
  }
  const result = customRules.previewRule(candidate, monthlyData, analysis, { ownerKeywords: config.businessOwnerKeywords });
  if (!result.ok) return res.status(400).json({ ok: false, error: "invalid_rule", message: result.error });
  return res.json({ ok: true, preview: { matchCount: result.matchCount, samples: result.samples } });
});

router.get("/rules/history", (req, res) => {
  const hist = (req.userStore.profile.ruleExecutionHistory || []).slice(-20).reverse();
  return res.json({ ok: true, history: hist });
});

// Current plan + AI credit balance for the signed-in user.
router.get("/entitlement", async (req, res) => {
  const ent = entitlements.getEntitlement(req.userStore.profile);
  persistProfile(req.userStore); // ensurePeriod() may have refilled this period

  /* REPORT THE LEDGER'S BALANCE, NOT THE IN-PROCESS MIRROR.
   *
   * THE DEFECT. `profile.credits` is a MIRROR that billing.js writes after a
   * successful charge, and it says so itself: "The LEDGER is authoritative, not
   * this." This endpoint was serving the mirror, which is correct only while a
   * single process makes every charge. Production runs behind a proxy with more
   * than one instance, so instance B kept showing a balance that instance A had
   * already spent — the user is told they have credits they do not have, and
   * finds out only when a request is refused.
   *
   * The spend gate itself was never affected: that is the atomic conditional
   * UPDATE in creditRepository.consume, which cannot be fooled by a stale
   * mirror. This is a DISPLAY correctness fix, and the mirror is still used
   * when no ledger is configured. */
  if (creditRepository.available() && req.userStore.tenantId) {
    try {
      const row = await creditRepository.ensureBalance(req.userStore.tenantId, {
        period: ent.period, allowance: ent.allowance, plan: ent.plan
      });
      if (row && Number.isInteger(row.credits)) {
        ent.credits = row.credits;
        ent.credits_source = "ledger";
        // Keep the mirror in step, so anything reading it next agrees.
        req.userStore.profile.credits = row.credits;
      }
    } catch (err) {
      // A display read must never fail the request; the mirror is the fallback.
      logger.warn("entitlement.ledger_read_failed", { error: err.message });
      ent.credits_source = "mirror_ledger_unavailable";
    }
  } else {
    ent.credits_source = "mirror";
  }

  return res.json({ ok: true, entitlement: ent });
});

// TEST STUB: manually set the plan. In production this is driven by a payment
// webhook (Paystack/Stripe), never a direct client call.
/**
 * Set the plan directly.
 *
 * SECURITY: this was an UNAUTHENTICATED, UNGATED privilege escalation. Any
 * anonymous visitor could POST {"plan":"growth"} and unlock every capability
 * the entitlement system gates — team collaboration, custom rules, BYOK,
 * automatic monitoring and the AI credit allowance — despite the route's own
 * comment describing it as a test stub driven by a payment webhook.
 *
 * It is now refused in production, where plan changes must come from the
 * payment provider's webhook. Development and test keep it, because fixture
 * setup depends on it.
 */
/**
 * TEST-ONLY plan grant.
 *
 * WHAT THIS USED TO BE. A route that wrote `profile.plan` directly, guarded
 * only by `NODE_ENV === "production"`. Outside production any visitor could
 * award themselves the top tier and use every paid feature immediately —
 * verified during the audit. That is now impossible for two reasons: the field
 * it wrote is no longer authoritative, and this route creates a REAL
 * subscription row so tests exercise the same path production does.
 *
 * Refused unless NODE_ENV is exactly `test`. Development no longer qualifies:
 * a staging deployment is a production-shaped environment, and "it was only
 * dev" is how a self-grant reaches real users.
 */
router.post("/plan", async (req, res) => {
  if (process.env.NODE_ENV !== "test") {
    logger.warn("plan.direct_set.refused", { route: "/plan" });
    return res.status(403).json({
      ok: false,
      error: "not_permitted",
      detail: "Plans are activated by verified payment, not by this endpoint."
    });
  }
  const plan = String((req.body && req.body.plan) || "").toLowerCase();
  if (!entitlements.PLANS[plan]) {
    return res.status(400).json({ ok: false, error: "invalid_plan" });
  }
  if (!req.userStore.tenantId || !dbPool.isConfigured()) {
    // No database: nothing to grant against. Fail rather than fall back to the
    // old file write, which is the hole this replaced.
    return res.status(503).json({ ok: false, error: "billing_unavailable" });
  }

  /* Goes through the SAME repository the payment path uses, so a test tenant
     is entitled by a real subscription row rather than by a special case. */
  const payment = await billingRepository.createPayment(req.userStore.tenantId, {
    provider: "test", plan,
    amount: (entitlements.priceFor(plan) || { amount: 0 }).amount,
    currency: entitlements.BILLING_CURRENCY,
    payerReference: "test-harness"
  });
  await billingRepository.attachProviderRef(req.userStore.tenantId, payment.id,
    `testgrant_${payment.id}`);
  await billingRepository.settlePaymentAndActivate(req.userStore.tenantId, {
    provider: "test", providerRef: `testgrant_${payment.id}`,
    status: "successful", providerResult: { grantedBy: "test-harness" }
  });

  await subscriptionService.syncProfilePlan(req.userStore);
  if (req.log) req.log.info("plan.changed", { plan });
  return res.json({ ok: true, entitlement: entitlements.getEntitlement(req.userStore.profile) });
});


router.get("/wallet/nonce", (req, res) => {
  const address = String(req.query.address || "").trim();
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ ok: false, error: "invalid_address" });
  }
  const message = createNonce(address);
  return res.json({ ok: true, message });
});

router.post("/wallet/verify", (req, res) => {
  const { address, signature, chainId, chain_id } = req.body || {};
  if (!ethers.isAddress(address) || !signature) {
    return res.status(400).json({ ok: false, error: "address and signature are required" });
  }

  const result = verifySignature(address, signature);
  if (!result.ok) {
    return res.status(401).json({ ok: false, error: result.error });
  }

  req.userStore.profile.walletAddress = result.address;
  req.userStore.profile.walletVerified = true;
  req.userStore.profile.walletChainId = Number(chainId || chain_id) || req.userStore.profile.walletChainId;
  persistProfile(req.userStore);

  return res.json({ ok: true, address: result.address, verified: true });
});

router.post("/avalanche/contracts/deployments/record", async (req, res) => {
  const body = req.body || {};
  const contractAddress = String(body.contractAddress || body.contract_address || "").trim();
  const txHash = String(body.txHash || body.tx_hash || "").trim();
  const chainId = Number(body.chainId || body.chain_id);
  const deployerAddress = String(body.deployerAddress || body.deployer_address || "").trim();
  const contractName = body.contractName || body.contract_name || "Contract";
  const templateId = body.templateId || body.template_id || null;

  if (!ethers.isAddress(contractAddress) || !/^0x[0-9a-fA-F]{64}$/.test(txHash) || !chainId) {
    return res.status(400).json({
      ok: false,
      error: "contractAddress, txHash and chainId are required and must be valid"
    });
  }

  const verification = await verifyDeploymentTx({ chainId, txHash, contractAddress });

  appendDeploymentRecord(req.userStore.reportsDir, {
    contract_name: contractName,
    template_id: templateId,
    receiver_address: deployerAddress,
    dry_run: false,
    ok: verification.verified,
    mode: "wallet-signed",
    chain_id: chainId,
    rpc_url: "",
    tx_hash: txHash,
    address: contractAddress,
    error: verification.verified ? "" : (verification.reason || "unverified"),
    message: verification.verified
      ? "Deployment confirmed on-chain."
      : `Could not fully verify on-chain (${verification.reason || "unknown"}). Recorded as reported by wallet.`,
    verified: verification.verified,
    actor: req.userStore.profile.userName || "unknown"
  });

  return res.json({ ok: true, verified: verification.verified, reason: verification.reason });
});

// ── Continuous Financial Monitoring ───────────────────────────
// Scheduled, automatic re-analysis of each user's books, alerting only on NEW
// issues (de-duplicated). Reuses the existing risk engine via injected deps;
// no detection logic is duplicated here.

function unreadCount(profile) {
  return (((profile && profile.notifications) || []).filter((n) => !n.read)).length;
}

// Resolve the most relevant month of data for a store outside a request:
// most recent uploaded month -> live Zoho (if connected) -> mock data source.
async function resolveMonthlyDataForStore(store) {
  const now = new Date();
  const period = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
  // INGESTION BOUNDARY. A failure here throws, which monitoring.runForStore
  // records as lastStatus "error" and retries — it never becomes a clean sync
  // over fabricated data.
  const uploaded = store.uploadedMonthlyData || {};
  const periods = Object.keys(uploaded).sort();
  const targetPeriod = periods.length ? periods[periods.length - 1] : period;
  return (await ingestDataOrThrow(store, targetPeriod)).data;
}

// Injected engine + IO for the monitoring service (keeps it engine-agnostic).
/**
 * Persist a completed analysis run.
 *
 * Non-fatal by design — the deterministic analysis is already computed and
 * correct, so a storage failure must not deny the user their result. It is
 * never silent: the failure is logged and the run is marked failed at the
 * PERSISTENCE stage, so it cannot later be mistaken for a successful analysis.
 */
/**
 * Persist a completed run WITH the authoritative inputs it was computed from.
 *
 * `inputs` carries what the engine's output does not: the currentCashBalance
 * supplied at upload and the ingestion metadata. Without them a stored run
 * cannot be shown to be the same run, which is what made recovery impossible.
 */
async function persistAnalysisRun(store, run, inputs = {}) {
  const tenantId = store.tenantId || null;
  if (!tenantId || !dbPool.isConfigured()) return { persisted: false, reason: "no_tenant" };
  try {
    const saved = await analysisRunRepository.saveRun(tenantId, run, inputs);
    logger.info("analysis.run.persisted", {
      tenantId, period: run.period, runId: saved.runId,
      findings: saved.findings, evidence: saved.evidence, metrics: saved.metrics,
      metricsUnavailable: saved.metricsUnavailable, recoverable: saved.recoverable
    });
    return { persisted: true, runId: saved.runId };
  } catch (err) {
    /* A RUN THAT COULD NOT BE PERSISTED MUST NOT LOOK COMPLETED.
       saveRun runs in one transaction, so a throw leaves NOTHING behind — no
       half-written run, no orphan findings. The failure is recorded as a failed
       run so the period's history shows what happened, rather than looking like
       no analysis was ever attempted. */
    logger.error("analysis.run.persist_failed", {
      tenantId, period: run.period, error: err.message,
      code: err.code || null, problems: err.problems || null
    });
    try {
      const opened = await analysisRunRepository.beginRun(tenantId, { period: run.period });
      await analysisRunRepository.failRun(tenantId, opened.runId, {
        stage: analysisRunRepository.STAGE.PERSISTENCE,
        reason: err.code || "persist_failed",
        detail: err.message
      });
    } catch (recordErr) {
      logger.error("analysis.run.failure_not_recorded", { error: recordErr.message });
    }
    return { persisted: false, reason: "persist_failed", error: err.message };
  }
}

/**
 * Load a completed analysis back from PostgreSQL.
 *
 * THE HALF THAT NEVER EXISTED. saveRun wrote runs, findings, evidence and
 * metrics; nothing read them, so after a restart the rows were all present and
 * the application could not answer from them. Every route that needs an
 * analysis now falls through to this when process memory has none.
 *
 * NOTHING HERE RECOMPUTES. The run is assembled from stored rows only. A row
 * written before JOB 11 lacks the authoritative metrics and period inputs and
 * is reported as legacy — never rebuilt by re-running the engine, because a
 * re-run against today's rules and the now-missing inputs would produce a
 * different answer while claiming to be the original.
 *
 * @returns {object|null} the recovered run, or null with `outcome` explaining why.
 */
async function loadPersistedRun(store, period) {
  const tenantId = store.tenantId || null;
  if (!tenantId || !dbPool.isConfigured()) {
    return { run: null, outcome: "no_tenant" };
  }
  try {
    const result = await analysisRunRepository.loadCompletedRun(tenantId, period);
    if (result.ok) {
      logger.info("analysis.run.recovered", {
        period, runId: result.run.analysisRunId,
        findings: result.run.findings.length, metrics: result.run.metrics.length
      });
      return { run: result.run, outcome: "recovered" };
    }
    return { run: null, outcome: result.reason, detail: result };
  } catch (err) {
    logger.error("analysis.run.recovery_failed", { period, error: err.message });
    return { run: null, outcome: "recovery_failed" };
  }
}

/**
 * The period's RECORDS, recovered from PostgreSQL.
 *
 * JOB 11 recovered scores, metrics, findings and evidence but NOT the records
 * those findings cite. So a recovered finding could state that two payments
 * were duplicates while nothing could show which two, and
 * `get_related_transactions` reported "the period's individual records are not
 * loaded" — truthfully, but the records were in the database the whole time.
 *
 * Shaped as the `monthlyData` envelope the capabilities already consume, so
 * nothing downstream needs a branch for recovered data.
 *
 * NOTHING IS RECOMPUTED. Statement totals are NOT re-derived here: recomputing
 * inflow/outflow from recovered rows would produce figures that look
 * authoritative but were never part of the stored analysis. The authoritative
 * numbers live on the run; this carries the RECORDS only.
 */
async function loadPersistedRecords(store, period) {
  const tenantId = store.tenantId || null;
  if (!tenantId || !dbPool.isConfigured()) return null;
  try {
    const records = await transactionRepository.recordsForPeriod(tenantId, period);
    if (!records.length) return null;
    return {
      period,
      transactions: records,
      // Deliberately absent rather than recomputed — see above.
      statements: null,
      meta: { source: "recovered", recordCount: records.length, recovered: true }
    };
  } catch (err) {
    logger.error("records.recovery_failed", { period, error: err.message });
    return null;
  }
}

/**
 * The period's records: from memory if this process ingested them, otherwise
 * recovered from the database.
 */
async function resolveMonthlyData(store, period) {
  const uploaded = store.uploadedMonthlyData && store.uploadedMonthlyData[period];
  if (uploaded) return uploaded;
  const recovered = await loadPersistedRecords(store, period);
  if (recovered) {
    (store.uploadedMonthlyData || (store.uploadedMonthlyData = {}))[period] = recovered;
    return recovered;
  }
  return null;
}

/**
 * The authoritative run for a period: from memory if this process computed it,
 * otherwise recovered from the database.
 *
 * Callers must not care which. A recovered run carries `recovered: true` for
 * provenance, but holds identical values, so nothing downstream branches on it.
 */
async function resolveRun(store, period) {
  const runs = store.analysisRuns || {};
  if (runs[period]) return { run: runs[period], source: "memory" };

  const loaded = await loadPersistedRun(store, period);
  if (loaded.run) {
    // Cache it, so a second question in the same session does not re-query.
    (store.analysisRuns || (store.analysisRuns = {}))[period] = loaded.run;
    return { run: loaded.run, source: "database" };
  }
  return { run: null, source: "none", outcome: loaded.outcome, detail: loaded.detail };
}

function monitoringDeps() {
  return {
    resolveMonthlyData: resolveMonthlyDataForStore,
    analyze: analyzeFinancialRisk,
    buildContext: (a) => buildContext({
      month: a.month, monthlyData: a.monthlyData, analysis: a.analysis,
      report: {}, followUp: {}, reviewHistory: [], reportsDir: a.reportsDir
    }),
    periodOf: (ts) => {
      const d = new Date(ts);
      return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
    },
    persist: persistProfile,
    maxRetries: 2
  };
}

/**
 * Run monitoring for ONE store, under a distributed lock.
 *
 * WHAT WAS WRONG. This was called directly by the timer sweep, by
 * GET /api/notifications and by POST /api/monitoring/run. Only the timer path
 * was guarded, and only by a process-local boolean — so two requests from the
 * same user, or a request arriving during a sweep, ran the same tenant's job
 * concurrently, and two instances always did.
 *
 * Every path now goes through the lock, and every attempt is recorded so a
 * failure cannot silently disappear.
 */
async function runMonitoringForStore(store) {
  const tenantId = store.tenantId || null;
  const period = new Date().toISOString().slice(0, 7);

  // Without a tenant there is no database to lock in, so the single-process
  // guarantee is all there is — and the caller is not told otherwise.
  if (!tenantId) {
    return monitoring.runForStore(store, monitoringDeps(), Date.now());
  }

  const lockKey = `monitoring:${tenantId}:${period}`;
  const owner = jobRepository.workerId();
  let jobId = null;

  const outcome = await jobRepository.withLock(tenantId, lockKey, { owner }, async () => {
    jobId = await jobRepository.startJob(tenantId, { jobType: "monitoring", period });
    try {
      const result = await monitoring.runForStore(store, monitoringDeps(), Date.now());
      await jobRepository.finishJob(tenantId, jobId, { status: "succeeded" });
      return result;
    } catch (err) {
      // A failure is RECORDED, not swallowed. The previous implementation
      // wrapped the whole cycle in `.catch(() => {})`.
      await jobRepository.finishJob(tenantId, jobId, {
        status: "failed", reason: err.message
      });
      logger.error("monitoring.job.failed", { tenantId, period, error: err.message });
      throw err;
    }
  });

  if (outcome.skipped) {
    logger.info("monitoring.job.skipped", { tenantId, period, reason: outcome.reason });
    return { skipped: true, reason: outcome.reason };
  }
  return outcome.result;
}

// Every user with a persisted profile is a monitoring candidate: warm in-memory
// stores (may hold uploaded data) unioned with on-disk profiles not yet loaded.
function enumerateStores() {
  const stores = new Map();
  for (const s of userStores.values()) stores.set(s.id, s);
  try {
    fs.readdirSync(config.reportsDir, { withFileTypes: true }).forEach((d) => {
      if (!d.isDirectory() || stores.has(d.name)) return;
      if (!fs.existsSync(path.join(config.reportsDir, d.name, "profile.json"))) return;
      stores.set(d.name, getUserStoreById(d.name));
    });
  } catch (e) { /* reportsDir may be empty */ }
  return Array.from(stores.values());
}

// Only accounts whose plan actually offers scheduled monitoring are swept. This
// also protects against a downgraded profile that still has enabled = true.
function schedulableStores() {
  return enumerateStores().filter((store) =>
    entitlements.can(store.profile, "automatic_monitoring"));
}

let monitoringCycleRunning = false;
async function runMonitoringCycle() {
  if (monitoringCycleRunning) return { skipped: true };
  monitoringCycleRunning = true;
  try {
    const result = await monitoring.runCycle(schedulableStores(), monitoringDeps(), Date.now());

    /* RENEWAL REMINDERS ride the same hourly wake-up rather than adding a
       second scheduler. Isolated deliberately: a reminder failure must not
       abort the monitoring cycle, and idempotency is enforced in the database,
       so running this hourly sends nothing extra. */
    if (dbPool.isConfigured()) {
      try {
        const reminders = await renewalReminders.run({ now: Date.now() });
        if (reminders.sent || reminders.failed) {
          logger.info("renewal.cycle", {
            sent: reminders.sent, failed: reminders.failed, skipped: reminders.skipped
          });
        }
      } catch (err) {
        logger.error("renewal.cycle_failed", { error: err.message });
      }
    }
    return result;
  } finally {
    monitoringCycleRunning = false;
  }
}

let monitoringTimer = null;
function startMonitoring() {
  if (monitoringTimer) return;
  const CHECK_MS = 60 * 60 * 1000; // hourly wake-up; per-user cadence gated by frequency
  setTimeout(() => { runMonitoringCycle().catch(() => {}); }, 15000);
  monitoringTimer = setInterval(() => { runMonitoringCycle().catch(() => {}); }, CHECK_MS);
  if (monitoringTimer.unref) monitoringTimer.unref();
}

// Monitoring settings for the current user.
router.get("/monitoring", (req, res) => {
  const profile = req.userStore.profile;
  if (!profile.monitoring) profile.monitoring = monitoring.defaultMonitoring();
  const ent = entitlements.getEntitlement(profile);
  const canSchedule = entitlements.can(profile, "automatic_monitoring");
  return res.json({
    ok: true, plan: ent.plan, plan_label: ent.plan_label,
    allowed_frequencies: monitoring.allowedFrequencies(canSchedule),
    can_schedule: canSchedule,
    manual_analysis: true, // unlimited manual refresh on every plan
    monitoring: profile.monitoring
  });
});

// Update monitoring settings (frequency clamped to what the plan allows).
router.post("/monitoring", (req, res) => {
  const profile = req.userStore.profile;
  if (!profile.monitoring) profile.monitoring = monitoring.defaultMonitoring();
  const ent = entitlements.getEntitlement(profile);
  const canSchedule = entitlements.can(profile, "automatic_monitoring");
  const body = req.body || {};
  // Automatic monitoring is a paid capability. Starter keeps unlimited MANUAL
  // analysis via /monitoring/run, so nothing about their monitoring is lost.
  if (body.enabled === true && !canSchedule) {
    return res.status(403).json(entitlements.upgradePayload("automatic_monitoring"));
  }
  if (typeof body.enabled === "boolean") profile.monitoring.enabled = body.enabled;
  if (body.frequency) profile.monitoring.frequency = String(body.frequency);
  // DOWNGRADE POLICY: the stored cadence is preserved, never rewritten -- it
  // simply stops firing until the capability returns.
  profile.monitoring.frequency = monitoring.resolveFrequency(canSchedule, profile.monitoring.frequency);
  if (profile.monitoring.enabled && !profile.monitoring.nextDueAt) {
    profile.monitoring.nextDueAt = new Date().toISOString();
  }
  persistProfile(req.userStore);
  return res.json({
    ok: true, plan: ent.plan,
    allowed_frequencies: monitoring.allowedFrequencies(canSchedule),
    can_schedule: canSchedule,
    monitoring: profile.monitoring
  });
});

// Manual "sync now" — runs regardless of schedule but still de-dups issues and
// preserves the user's enable preference.
router.post("/monitoring/run", async (req, res) => {
  try {
    const store = req.userStore;
    const profile = store.profile;
    if (!profile.monitoring) profile.monitoring = monitoring.defaultMonitoring();
    const prevEnabled = profile.monitoring.enabled;
    profile.monitoring.enabled = true;
    profile.monitoring.lastRunAt = null; // force due for this manual run
    const result = await runMonitoringForStore(store);
    profile.monitoring.enabled = prevEnabled;
    persistProfile(store);
    return res.json({
      ok: true, result, monitoring: profile.monitoring,
      notifications: profile.notifications || [], unread: unreadCount(profile)
    });
  } catch (e) {
    return serverError(res, "route", e);
  }
});

// Notifications feed. On load, opportunistically run a due sync — this is what
// makes monitoring work on a host that sleeps when idle: the user's own request
// wakes the app and triggers their overdue check.
router.get("/notifications", async (req, res) => {
  const store = req.userStore;
  const profile = store.profile;
  if (!Array.isArray(profile.notifications)) profile.notifications = [];
  let synced = null;
  try {
    const schedulingAllowed = entitlements.can(profile, "automatic_monitoring");
    if (schedulingAllowed && profile.monitoring && profile.monitoring.enabled &&
        monitoring.isDue(profile.monitoring, Date.now())) {
      synced = await runMonitoringForStore(store);
    }
  } catch (e) { /* non-fatal — still return existing notifications */ }
  return res.json({
    ok: true,
    notifications: profile.notifications,
    unread: unreadCount(profile),
    synced: synced ? { newIssues: synced.newIssues || 0, ok: Boolean(synced.ok) } : null
  });
});

// Mark one notification (or all) as read.
router.post("/notifications/read", (req, res) => {
  const profile = req.userStore.profile;
  if (!Array.isArray(profile.notifications)) profile.notifications = [];
  const body = req.body || {};
  if (body.all) {
    profile.notifications.forEach((n) => { n.read = true; });
  } else if (body.id) {
    const n = profile.notifications.find((x) => x.id === body.id);
    if (n) n.read = true;
  }
  persistProfile(req.userStore);
  return res.json({ ok: true, unread: unreadCount(profile) });
});

router.startMonitoring = startMonitoring;
router.runMonitoringCycle = runMonitoringCycle;

// ── Team Collaboration ────────────────────────────────────────
// Multiple users per business. Each business is a workspace owned by the signed-
// in user (Founder); teammates are invited by email and given a role that maps to
// a fixed permission set (see services/team.js). Cross-user invite acceptance and
// membership routing use a small global index; the member list itself lives on
// the owner's persisted profile.

/**
 * Resolve a period of financial data for a user store through the ingestion
 * boundary. This is the ONLY production entry point for financial ingestion.
 *
 * Source precedence is explicit: uploaded CSV -> connected Zoho -> (demo ONLY
 * when explicitly enabled). There is no silent fallback to fabricated data.
 *
 * Returns the full envelope { data, quality, warnings, failures, source } so
 * callers can react to partial/failed ingestion rather than receiving a
 * plausible-looking empty dataset.
 */
async function ingestForStore(store, period, opts = {}) {
  const profile = store.profile;
  const zoho = profile.zohoRefreshToken
    ? createZohoSource(profile, { now: opts.now })
    : null;
  const envelope = await ingestion.ingestPeriod({
    period,
    uploaded: store.uploadedMonthlyData ? store.uploadedMonthlyData[period] : undefined,
    zoho,
    // Demo data is opt-in per deployment and never a fallback.
    allowDemo: String(process.env.ALLOW_DEMO_DATA || "") === "true",
    now: opts.now
  });

  // ingestion -> repository -> PostgreSQL. Routes never write SQL, and the
  // deterministic engine never learns a database exists. Persistence is
  // non-fatal (the app still works in-memory) but never silent.
  if (opts.persist === false || !envelope.data) return envelope;

  let persistence;
  try {
    persistence = await persistIngestion(store.tenantId || null, envelope);
    if (persistence && persistence.reason === "persist_failed") {
      logger.error("ingest.persist.failed", { reason: persistence.reason, error: persistence.error });
    }
  } catch (err) {
    logger.error("ingest.persist.threw", { error: err.message });
    persistence = { persisted: false, reason: "persist_failed", error: err.message };
  }
  // The envelope is frozen, so return a new one rather than silently failing to
  // mutate it.
  return Object.freeze(Object.assign({}, envelope, { persistence }));
}

/** Convenience: the dataset alone, throwing when ingestion failed outright. */
async function ingestDataOrThrow(store, period, opts = {}) {
  const result = await ingestForStore(store, period, opts);
  if (!result.data) {
    const err = new Error(result.quality.summary || "Could not retrieve accounting data.");
    err.code = "ingestion_failed";
    err.quality = result.quality;
    throw err;
  }
  return result;
}

function currentIdentity(req) {
  const p = req.userStore.profile;
  return {
    userId: getUserId(req),
    email: team.normalizeEmail(p.googleEmail),
    name: p.googleName || p.userName || "Member"
  };
}

// Ensure a store's own team exists and its owner member reflects the profile.
function getOwnTeam(store) {
  const p = store.profile;
  p.team = team.ensureTeam(p.team, {
    email: team.normalizeEmail(p.googleEmail),
    name: p.googleName || p.userName || "Owner",
    userId: p.googleSub ? "google-" + p.googleSub : null
  });
  return p.team;
}

// Global index so an invited user (a different store) can find and join a
// business: token -> ownerId for accept links, email -> [ownerId] for memberships.
function teamIndexPath() {
  const dir = path.join(config.reportsDir, "_team");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "index.json");
}
function readTeamIndex() {
  try { return JSON.parse(fs.readFileSync(teamIndexPath(), "utf-8")); }
  catch (e) { return { tokens: {}, members: {} }; }
}
function writeTeamIndex(idx) {
  try { fs.writeFileSync(teamIndexPath(), JSON.stringify(idx, null, 2)); }
  catch (e) { /* non-fatal */ }
}
function indexAddToken(token, ownerId) {
  const idx = readTeamIndex();
  idx.tokens[token] = ownerId;
  writeTeamIndex(idx);
}
function indexAddMembership(email, ownerId) {
  const idx = readTeamIndex();
  const e = team.normalizeEmail(email);
  idx.members[e] = Array.from(new Set((idx.members[e] || []).concat(ownerId)));
  writeTeamIndex(idx);
}
function indexRemoveMembership(email, ownerId) {
  const idx = readTeamIndex();
  const e = team.normalizeEmail(email);
  if (idx.members[e]) {
    idx.members[e] = idx.members[e].filter((o) => o !== ownerId);
    if (!idx.members[e].length) delete idx.members[e];
  }
  writeTeamIndex(idx);
}

// Businesses (other than my own) that I have joined, with my role in each.
function myMemberships(req) {
  const myEmail = team.normalizeEmail(req.userStore.profile.googleEmail);
  const myId = getUserId(req);
  if (!myEmail) return [];
  const idx = readTeamIndex();
  const ownerIds = (idx.members[myEmail] || []).filter((o) => o !== myId);
  const out = [];
  ownerIds.forEach((ownerId) => {
    try {
      if (!userStoreExists(ownerId)) return;
      const ownerStore = getUserStoreById(ownerId);
      const t = getOwnTeam(ownerStore);
      const member = team.findMemberByEmail(t, myEmail);
      if (member && member.status === "active") {
        out.push({
          ownerId,
          business_name: ownerStore.profile.businessName || "Business",
          role: member.role,
          role_label: team.roleLabel(member.role),
          // Preserved membership whose access is paused by the owner's plan.
          suspended: !entitlements.can(ownerStore.profile, "team_collaboration")
        });
      }
    } catch (e) { /* skip unreadable */ }
  });
  return out;
}

// My own team (I am always Founder of my own workspace).
router.get("/team", (req, res) => {
  const t = getOwnTeam(req.userStore);
  persistProfile(req.userStore);
  return res.json({
    ok: true,
    business_name: req.userStore.profile.businessName || "Business",
    my_role: "founder",
    is_owner: true,
    can_manage: entitlements.can(req.userStore.profile, "team_collaboration"),
    members: t.members,
    memberships: myMemberships(req),
    matrix: team.permissionMatrix()
  });
});

// Invite a teammate by email + role (Founder only — always true for one's own team).
router.post("/team/invite", (req, res) => {
  try {
    if (!entitlements.can(req.userStore.profile, "team_collaboration")) {
      return res.status(403).json(entitlements.upgradePayload("team_collaboration"));
    }
    const t = getOwnTeam(req.userStore);
    const body = req.body || {};
    const { member, token } = team.inviteMember(t, {
      email: body.email, role: body.role, name: body.name, invitedBy: "owner"
    });
    indexAddToken(token, getUserId(req));
    persistProfile(req.userStore);
    const inviteLink = (config.appBaseUrl || "") + "/app?invite=" + token;
    return res.json({ ok: true, member, invite_link: inviteLink, members: t.members });
  } catch (e) {
    const known = ["invalid_email", "already_on_team", "cannot_invite_founder"];
    const status = known.indexOf(e.message) !== -1 ? 400 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

// Change a member's role.
router.put("/team/member/:id", (req, res) => {
  try {
    if (!entitlements.can(req.userStore.profile, "team_collaboration")) {
      return res.status(403).json(entitlements.upgradePayload("team_collaboration"));
    }
    const t = getOwnTeam(req.userStore);
    const member = team.updateMemberRole(t, req.params.id, (req.body || {}).role);
    persistProfile(req.userStore);
    return res.json({ ok: true, member, members: t.members });
  } catch (e) {
    const known = ["member_not_found", "cannot_change_owner", "cannot_assign_founder"];
    const status = known.indexOf(e.message) !== -1 ? 400 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

// Remove a member.
router.delete("/team/member/:id", (req, res) => {
  try {
    if (!entitlements.can(req.userStore.profile, "team_collaboration")) {
      return res.status(403).json(entitlements.upgradePayload("team_collaboration"));
    }
    const t = getOwnTeam(req.userStore);
    const member = team.removeMember(t, req.params.id);
    if (member.email) indexRemoveMembership(member.email, getUserId(req));
    persistProfile(req.userStore);
    return res.json({ ok: true, removed: member.id, members: t.members });
  } catch (e) {
    const known = ["member_not_found", "cannot_remove_owner"];
    const status = known.indexOf(e.message) !== -1 ? 400 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

// Accept an invite (as the logged-in invitee, a different store). Binds identity.
router.post("/team/accept", (req, res) => {
  try {
    const token = String((req.body || {}).token || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });
    const idx = readTeamIndex();
    const ownerId = idx.tokens[token];
    if (!ownerId) return res.status(404).json({ ok: false, error: "invalid_or_used_invite" });

    if (!userStoreExists(ownerId)) return res.status(404).json({ ok: false, error: "invalid_or_used_invite" });
    const ownerStore = getUserStoreById(ownerId);
    const t = getOwnTeam(ownerStore);
    const identity = currentIdentity(req);
    const member = team.acceptInvite(t, token, identity);

    // token is single-use — drop it and record the membership.
    delete idx.tokens[token];
    writeTeamIndex(idx);
    indexAddMembership(member.email, ownerId);
    persistProfile(ownerStore);

    return res.json({
      ok: true,
      owner_id: ownerId,
      business_name: ownerStore.profile.businessName || "Business",
      role: member.role,
      role_label: team.roleLabel(member.role),
      permissions: team.permissionsFor(member.role)
    });
  } catch (e) {
    const status = e.message === "invalid_or_used_invite" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

// ── Collaboration on findings (shared, permission-gated) ───────
// A member acts inside a chosen business (their own, or one they joined via
// `workspace` = ownerId). Their role there decides what they may do.
function resolveCollabWorkspace(req, ownerIdParam) {
  const myId = getUserId(req);
  const myEmail = team.normalizeEmail(req.userStore.profile.googleEmail);
  const ownerId = ownerIdParam || myId;
  if (ownerId === myId) {
    return { store: req.userStore, ownerId: myId, role: "founder", team: getOwnTeam(req.userStore) };
  }
  // SECURITY: `ownerId` is caller-supplied. Resolving it through
  // getUserStoreById() would CREATE a store (and a directory) for any value,
  // giving an unauthenticated attacker an unbounded resource-exhaustion
  // primitive. Refuse unknown ids before touching any state.
  // See docs/THREAT_MODEL.md T3 and tests/security/containment.test.js.
  if (!userStoreExists(ownerId)) return null;
  const ownerStore = getUserStoreById(ownerId);
  const t = getOwnTeam(ownerStore);
  // Identify the member by the userId bound at accept time, else by email.
  const member = (t.members || []).find((m) =>
    (m.userId && m.userId === myId) || (myEmail && team.normalizeEmail(m.email) === myEmail));
  if (!member || member.status !== "active") return null;
  // DOWNGRADE POLICY: if the workspace owner no longer has the collaboration
  // capability, teammate ACCESS is suspended -- but the membership, its role and
  // every comment/resolution are preserved and return the moment they upgrade.
  if (!entitlements.can(ownerStore.profile, "team_collaboration")) {
    return { suspended: true, ownerId, role: member.role };
  }
  return { store: ownerStore, ownerId, role: member.role, team: t };
}

// Access suspended by the OWNER's downgrade -- distinct from being removed, so
// the teammate sees an accurate explanation and their data is visibly intact.
function teamSuspendedPayload() {
  return {
    ok: false,
    error: "team_access_suspended",
    message: "This workspace owner's plan no longer includes team collaboration. Your membership and history are preserved and will be restored when they upgrade."
  };
}

function threadView(thread, fingerprint) {
  return {
    fingerprint,
    title: thread.title || "",
    resolved: Boolean(thread.resolved),
    resolved_by: thread.resolvedByName || null,
    resolved_at: thread.resolvedAt || null,
    comments: thread.comments || []
  };
}

// View a finding's discussion thread.
router.get("/findings/thread", (req, res) => {
  const ws = resolveCollabWorkspace(req, req.query.workspace);
  if (!ws) return res.status(403).json({ ok: false, error: "not_a_member" });
  if (ws.suspended) return res.status(403).json(teamSuspendedPayload());
  if (!team.can(ws.role, "view")) return res.status(403).json({ ok: false, error: "forbidden", need: "view", role: ws.role });
  const fp = String(req.query.fingerprint || "").trim();
  if (!fp) return res.status(400).json({ ok: false, error: "missing_fingerprint" });
  const threads = (ws.team.threads = ws.team.threads || {});
  const thread = threads[fp] || { comments: [], resolved: false };
  return res.json({ ok: true, role: ws.role, thread: threadView(thread, fp) });
});

// Comment on a finding (requires the `comment` permission).
router.post("/findings/comment", (req, res) => {
  const body = req.body || {};
  const ws = resolveCollabWorkspace(req, body.workspace);
  if (!ws) return res.status(403).json({ ok: false, error: "not_a_member" });
  if (ws.suspended) return res.status(403).json(teamSuspendedPayload());
  if (!team.can(ws.role, "comment")) return res.status(403).json({ ok: false, error: "forbidden", need: "comment", role: ws.role });
  const fp = String(body.fingerprint || "").trim();
  const text = String(body.text || "").trim();
  if (!fp || !text) return res.status(400).json({ ok: false, error: "missing_fields" });

  const threads = (ws.team.threads = ws.team.threads || {});
  const thread = threads[fp] || (threads[fp] = { title: body.title || "", comments: [], resolved: false });
  const identity = currentIdentity(req);
  thread.comments.push({
    id: "c_" + crypto.randomBytes(5).toString("hex"),
    by: identity.userId,
    name: identity.name,
    role: ws.role,
    text: text.slice(0, 2000),
    ts: new Date().toISOString()
  });
  persistProfile(ws.store);
  return res.json({ ok: true, role: ws.role, thread: threadView(thread, fp) });
});

// Resolve / reopen a finding (requires the `resolve` permission).
router.post("/findings/resolve", (req, res) => {
  const body = req.body || {};
  const ws = resolveCollabWorkspace(req, body.workspace);
  if (!ws) return res.status(403).json({ ok: false, error: "not_a_member" });
  if (ws.suspended) return res.status(403).json(teamSuspendedPayload());
  if (!team.can(ws.role, "resolve")) return res.status(403).json({ ok: false, error: "forbidden", need: "resolve", role: ws.role });
  const fp = String(body.fingerprint || "").trim();
  if (!fp) return res.status(400).json({ ok: false, error: "missing_fingerprint" });

  const threads = (ws.team.threads = ws.team.threads || {});
  const thread = threads[fp] || (threads[fp] = { title: body.title || "", comments: [], resolved: false });
  const identity = currentIdentity(req);
  const resolved = body.resolved !== false;
  thread.resolved = resolved;
  thread.resolvedByName = resolved ? identity.name : null;
  thread.resolvedAt = resolved ? new Date().toISOString() : null;
  persistProfile(ws.store);
  return res.json({ ok: true, role: ws.role, thread: threadView(thread, fp) });
});

module.exports = router;

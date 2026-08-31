#!/usr/bin/env node
"use strict";

// Backend-only admin utility to reverse a prior workspace credit grant.
// This is intentionally not exposed as an app API route.

const dbPool = require("../src/db/pool");
const entitlements = require("../src/services/entitlements");
const creditRepository = require("../src/db/repositories/creditRepository");
const subscriptionService = require("../src/services/subscriptionService");

function usage() {
  console.log([
    "Usage:",
    "  node scripts/revoke-credits.js --tenant-id <uuid> --amount <int> [--period <key>] [--reason <text>]",
    "  node scripts/revoke-credits.js --email <user@email> --amount <int> [--period <key>] [--reason <text>]",
    "",
    "Notes:",
    "  - --period defaults to the current credit period key (12-hour window).",
    "  - If --email belongs to multiple tenants, pass --tenant-id explicitly.",
    "  - This subtracts workspace-level credits and allowance.",
  ].join("\n"));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

async function tenantIdFromEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw new Error("invalid_email");

  return dbPool.withAdmin(async (client) => {
    const { rows } = await client.query(
      `SELECT DISTINCT m.tenant_id
         FROM membership m
         JOIN app_user u ON u.id = m.user_id
        WHERE m.status = 'active' AND lower(u.email) = $1`,
      [normalized]
    );

    if (!rows.length) throw new Error("email_not_found");
    if (rows.length > 1) throw new Error("email_multi_tenant");
    return rows[0].tenant_id;
  });
}

function mapFailureReason(reason) {
  if (reason === "insufficient_credits") {
    return "cannot revoke that amount because the workspace has already used some of those credits";
  }
  if (reason === "insufficient_allowance") {
    return "cannot revoke that amount because it exceeds the period allowance";
  }
  if (reason === "no_balance") {
    return "no credit balance exists for that tenant and period";
  }
  return "revoke failed";
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const amount = Number(args.amount);
  const maxRevoke = Number(process.env.MAX_CREDIT_REVOKE || 1000000);

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("amount must be a positive integer");
  }
  if (Number.isInteger(maxRevoke) && maxRevoke > 0 && amount > maxRevoke) {
    throw new Error(`amount exceeds MAX_CREDIT_REVOKE (${maxRevoke})`);
  }

  if (!dbPool.isConfigured()) {
    throw new Error("DATABASE_URL is not configured");
  }

  let tenantId = args["tenant-id"] ? String(args["tenant-id"]).trim() : "";
  if (!tenantId && args.email) {
    tenantId = await tenantIdFromEmail(args.email);
  }
  if (!tenantId) {
    throw new Error("provide --tenant-id or --email");
  }

  const resolved = await subscriptionService.resolvePlan(tenantId);
  const profile = { plan: resolved.plan, credits: 0, creditsPeriod: null };
  const ent = entitlements.getEntitlement(profile);
  const period = args.period ? String(args.period).trim() : ent.period;

  if (ent.byok || ent.allowance == null) {
    throw new Error("target workspace is unmetered (BYOK), managed credits do not apply");
  }

  await creditRepository.ensureBalance(tenantId, {
    period,
    allowance: ent.allowance,
    plan: ent.plan
  });

  const reason = String(args.reason || "admin_manual_reversal").slice(0, 120);
  const result = await creditRepository.revokeGrant(tenantId, {
    period,
    amount,
    operation: `admin_revoke:${reason}`,
    interactionId: "admin-cli"
  });

  if (!result.ok) {
    throw new Error(mapFailureReason(result.reason));
  }

  console.log(JSON.stringify({
    ok: true,
    tenant_id: tenantId,
    plan: ent.plan,
    period,
    debited: amount,
    credits: result.remaining,
    allowance: result.allowance,
    scope: "workspace_shared"
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("ERROR:", err.message || String(err));
    usage();
    process.exit(1);
  })
  .finally(async () => {
    try { await dbPool.close(); } catch (_) { }
  });

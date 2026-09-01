// TENANT PROFILE STATE (PostgreSQL-backed).
//
// Holds profile-level application state that was previously persisted to
// per-instance profile.json files. Tenant-scoped through withTenant + RLS.

const { withTenant, isConfigured } = require("../pool");

async function load(tenantId) {
  if (!tenantId) return null;
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT tenant_id, profile, created_at, updated_at
         FROM tenant_profile_state
        WHERE tenant_id = $1`,
      [tenantId]
    );
    return rows[0] || null;
  });
}

async function upsert(tenantId, profile) {
  if (!tenantId) throw new Error("tenantId is required");
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("profile must be an object");
  }

  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tenant_profile_state (tenant_id, profile)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id)
       DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()
       RETURNING tenant_id, profile, created_at, updated_at`,
      [tenantId, JSON.stringify(profile)]
    );
    return rows[0];
  });
}

function available() {
  return isConfigured();
}

module.exports = { load, upsert, available };

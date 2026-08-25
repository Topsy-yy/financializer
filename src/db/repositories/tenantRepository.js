// Tenant, user and membership persistence. Admin-scoped: creating a tenant
// necessarily happens before a tenant scope exists.
const { withAdmin, withTenant } = require("../pool");

async function createUser({ email = null, googleSub = null, displayName = null }) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO app_user (email, google_sub, display_name) VALUES ($1,$2,$3)
       ON CONFLICT (google_sub) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING *`,
      [email, googleSub, displayName]
    );
    return rows[0];
  });
}

async function createTenant({ name, baseCurrency = "KES" }) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      "INSERT INTO tenant (name, base_currency) VALUES ($1,$2) RETURNING *",
      [name, baseCurrency]
    );
    return rows[0];
  });
}

async function addMember({ tenantId, userId, role, status = "active" }) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO membership (tenant_id, user_id, role, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [tenantId, userId, role, status]
    );
    return rows[0];
  });
}

/** Tenants a user may access — the authorisation source for request scoping. */
async function tenantsForUser(userId) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      `SELECT t.*, m.role FROM tenant t
       JOIN membership m ON m.tenant_id = t.id
       WHERE m.user_id = $1 AND m.status = 'active'
       ORDER BY t.created_at`,
      [userId]
    );
    return rows;
  });
}

/** Tenant-scoped read: proves the scope works end to end. */
async function membersOf(tenantId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query("SELECT * FROM membership ORDER BY created_at");
    return rows;
  });
}

module.exports = { createUser, createTenant, addMember, tenantsForUser, membersOf };

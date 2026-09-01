-- JOB PERSISTENCE HARDENING — durable tenant profile state.
--
-- WHY THIS EXISTS.
-- The application still persisted core profile state (business/user settings,
-- Zoho connection metadata, AI key envelope, monitoring preferences, team
-- metadata) in profile.json on local disk. That is prototype persistence:
-- instance-local and fragile across redeploys.
--
-- This table moves that state to PostgreSQL under tenant isolation.
-- Credentials stay encrypted at the application layer (secretStore envelope),
-- and the encrypted values are stored as part of the profile document.

CREATE TABLE IF NOT EXISTS tenant_profile_state (
  tenant_id    uuid        PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  profile      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(profile) = 'object')
);

CREATE INDEX IF NOT EXISTS tenant_profile_state_updated_idx
  ON tenant_profile_state (updated_at DESC);

ALTER TABLE tenant_profile_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_profile_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_profile_state_tenant_isolation ON tenant_profile_state;
CREATE POLICY tenant_profile_state_tenant_isolation ON tenant_profile_state
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

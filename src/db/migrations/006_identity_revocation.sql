-- FINAL CLOSURE — server-side revocation for the long-lived identity cookie.
--
-- THE DEFECT. Login issues `fg_google_sub`, a signed cookie with a 400-day
-- lifetime, and the identity resolver accepts it whenever the session is
-- absent. That made an identity survive a restart back when sessions lived in
-- memory — and it made the cookie a 400-day bearer credential with no
-- server-side revocation. Logout cleared it from the responding browser; a copy
-- taken beforehand stayed valid for over a year, because there was nothing to
-- check it against.
--
-- THE MECHANISM. One row per identity holding a monotonically increasing
-- version. Cookies carry the version that was current when they were issued, so
-- incrementing this row invalidates the original AND every copy in a single
-- write. Authentication itself is unchanged.
--
-- NOT under RLS, deliberately: this table is consulted to ESTABLISH an identity,
-- before any tenant is known, so a tenant-scoped policy would make it
-- unreadable at exactly the moment it is needed. It holds no tenant data — a
-- subject identifier and a counter — and is only ever read by primary key.

CREATE TABLE IF NOT EXISTS identity_revocation (
  -- The identity provider's subject id (a Google `sub`). Not a tenant id.
  subject    text        PRIMARY KEY,
  -- Incremented on every logout or explicit revocation.
  version    integer     NOT NULL DEFAULT 0 CHECK (version >= 0),
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_revocation_revoked_at_idx
  ON identity_revocation (revoked_at DESC);

GRANT SELECT, INSERT, UPDATE ON identity_revocation TO PUBLIC;

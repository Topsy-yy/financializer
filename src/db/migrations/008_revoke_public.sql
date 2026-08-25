-- JOB 13 PHASE A — remove PUBLIC access to every database object.
--
-- THE DEFECT. Migrations 004-007 grant to PUBLIC, which in PostgreSQL means
-- EVERY role in the cluster, present and future. A live inventory found 16
-- tables and 3 sequences reachable that way:
--
--   financial_transaction, analysis_run, finding, finding_evidence,
--   metric_value        -- the tenant's financial records and analyses
--   credit_balance, credit_transaction, ai_interaction  -- billing and AI audit
--   conversation, conversation_turn, conversation_entity -- chat history
--   user_session, identity_revocation                    -- session material
--   job_lock, job_run, notification_dedupe               -- scheduling
--
-- WHY THIS MATTERS EVEN THOUGH RLS EXISTS. Row-level security confines a role to
-- one tenant; it does not stop a role reaching the table at all, and several of
-- these tables deliberately sit OUTSIDE RLS because they are consulted before a
-- tenant is known -- `user_session` (session material) and `identity_revocation`
-- most importantly. For those, PUBLIC was the only gate, and it was open. Any
-- role that could connect -- a reporting user, a BI tool, a future service
-- account, an analytics sidecar -- could read every session row in the system.
--
-- WHICH OBJECTS GENUINELY NEED PUBLIC ACCESS: none. The application connects as
-- one restricted role, and migrations run as the owner, who is unaffected by
-- grants. There is no third consumer.
--
-- ORDERING. This runs inside the migration runner's transaction, and the runner
-- applies the application role's own grants immediately afterwards in the SAME
-- transaction (src/db/migrate.js -> src/db/grants.js). There is therefore no
-- window in which the application has lost access. The runner REFUSES to
-- proceed past this migration without APP_DB_ROLE configured, because after it
-- an unnamed application role has no path to the data at all.
--
-- THIS IS THE UPGRADE PATH TOO. Existing databases carrying the old PUBLIC
-- grants are corrected by the same statements; REVOKE on a privilege that was
-- never granted is a no-op, so a clean bootstrap and an upgrade converge on the
-- identical end state.

-- ── Tables and sequences ─────────────────────────────────────────
-- ALL PRIVILEGES rather than an enumerated list: the point is that PUBLIC ends
-- up with nothing, and enumerating would silently miss a privilege a future
-- migration adds.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Stop future objects from being handed to PUBLIC by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;

/* ── Schema USAGE ─────────────────────────────────────────────────
   PostgreSQL grants USAGE on `public` to PUBLIC by default, which lets any role
   resolve names inside it. Revoking narrows the surface to roles granted USAGE
   explicitly -- which src/db/grants.js does for the application role on every
   migration run.

   NOT revoked from the database owner: the owner runs migrations, and pgcrypto
   (gen_random_uuid, used in column DEFAULTs across this schema) is installed
   here. The application role keeps explicit USAGE, so those DEFAULTs still
   evaluate on its inserts. */
REVOKE USAGE ON SCHEMA public FROM PUBLIC;

/* ── DDL DRIFT ────────────────────────────────────────────────────
   An environment built before the documented bootstrap existed was repaired by
   hand with `GRANT ALL ON SCHEMA public`, which includes CREATE. A role that can
   create objects in the schema it queries is more privileged than this
   application needs, and the bootstrap path never grants it. This brings such a
   database back in line with what a clean bootstrap produces.

   CREATE is revoked from PUBLIC and from every non-superuser role that holds it
   on this schema, EXCEPT the owner. Expressed against pg_roles rather than a
   hardcoded name because the application role name varies per deployment. */
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
      FROM pg_roles
     WHERE rolcanlogin
       AND NOT rolsuper
       AND rolname NOT LIKE 'pg\_%'
       AND has_schema_privilege(rolname, 'public', 'CREATE')
       AND rolname <> (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public')
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r.rolname);
    RAISE NOTICE 'revoked CREATE on schema public from %', r.rolname;
  END LOOP;
END
$$;

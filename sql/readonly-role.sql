-- Read-only database role for the ledger verifier (Stage A1 / E2).
-- Run ONCE in the Supabase SQL editor (it needs admin rights).
-- Before running: replace CHANGE_ME with a long random password, e.g. from
--   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
-- and keep it only in the verifier repo's GitHub secret DATABASE_URL.
--
-- The role can SELECT the three ledger tables and nothing else, every
-- transaction it opens is read-only, and it can't create objects.

CREATE ROLE ledger_verifier WITH LOGIN PASSWORD 'CHANGE_ME'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 3;

ALTER ROLE ledger_verifier SET default_transaction_read_only = on;
ALTER ROLE ledger_verifier SET statement_timeout = '120s';

GRANT CONNECT ON DATABASE postgres TO ledger_verifier;
GRANT USAGE ON SCHEMA public TO ledger_verifier;
GRANT SELECT ON "Rewards", "RewardsSeal", "LedgerAnchor" TO ledger_verifier;
REVOKE CREATE ON SCHEMA public FROM ledger_verifier;

-- If row level security is on for any of the three tables, a role without
-- a policy silently reads ZERO rows. Add a read-only policy for the
-- verifier on each table that has RLS enabled (no-op otherwise).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Rewards', 'RewardsSeal', 'LedgerAnchor'] LOOP
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      EXECUTE format('CREATE POLICY ledger_verifier_read ON public.%I FOR SELECT TO ledger_verifier USING (true)', t);
      RAISE NOTICE 'RLS is on for %, added a read policy for ledger_verifier', t;
    END IF;
  END LOOP;
END $$;

-- Check: should list exactly SELECT on the three tables.
SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'ledger_verifier'
 ORDER BY table_name;

-- Connection string for the GitHub secret DATABASE_URL (Supabase session
-- pooler; copy host and project ref from Project Settings > Database):
--   postgresql://ledger_verifier.<project-ref>:<password>@<pooler-host>:5432/postgres

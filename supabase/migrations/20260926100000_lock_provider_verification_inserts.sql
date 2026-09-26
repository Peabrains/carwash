-- Verification submissions must use submit_provider_verification so reviewed
-- snapshots, versions, paths, and actor identity are generated atomically.
drop policy if exists provider_verifications_owner_insert on public.provider_verifications;

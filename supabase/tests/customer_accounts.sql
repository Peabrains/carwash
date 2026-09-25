begin;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'customer_profiles') then
    raise exception 'customer_profiles table is missing';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'customer_vehicles') then
    raise exception 'customer_vehicles table is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'customer_user_id'
  ) then
    raise exception 'appointments.customer_user_id is missing';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('customer_profiles', 'customer_vehicles')
      and (coalesce(qual, '') || coalesce(with_check, '')) not like '%auth.uid()%'
  ) then
    raise exception 'customer-owned policy is missing auth.uid ownership check';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'appointments'
      and policyname = 'customers_read_own_appointments'
      and qual like '%auth.uid()%customer_user_id%'
  ) then
    raise exception 'customer appointment history policy is missing';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'customer_vehicles'
      and indexname = 'customer_vehicles_one_default_idx'
      and indexdef like '%UNIQUE%WHERE (is_default = true)%'
  ) then
    raise exception 'customer default vehicle uniqueness is missing';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('customer_profiles', 'customer_vehicles')
      and grantee = 'anon'
  ) then
    raise exception 'anonymous users can access customer-owned tables';
  end if;
end
$$;

rollback;

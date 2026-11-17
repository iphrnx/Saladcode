-- Migration: 20261116000002_update_pricing_plans_and_qr_limits.sql
-- 1. Starter ₹999/month = 50 QR codes maximum
-- 2. Pro ₹2,499/month = 100 QR codes maximum
-- 3. Remove 5999 plan (enterprise) completely
-- 4. Server-side atomic enforcement for table / QR code creation within plan limits

-- 1. Ensure max_tables column exists on subscription_plans
alter table public.subscription_plans
  add column if not exists max_tables integer default 50;

-- 2. Update Starter plan (₹999/mo, ₹9,990/yr, 50 QR codes maximum)
update public.subscription_plans
   set name = 'Starter',
       description = 'Essential POS for independent restaurants and cafes',
       price_monthly = 999.00,
       price_yearly = 9990.00,
       currency = 'INR',
       trial_days = 14,
       is_active = true,
       is_popular = false,
       max_locations = 1,
       max_staff = 5,
       max_menu_items = 100,
       max_tables = 50,
       features = '[
         "50 QR codes maximum",
         "AI menu scanning with instant extraction",
         "QR ordering",
         "Kitchen display",
         "Up to 100 menu items",
         "1 restaurant location",
         "Up to 5 staff members with roles",
         "Advanced analytics",
         "Email support"
       ]'::jsonb,
       feature_keys = array['pos', 'qr', 'orders', 'reports', 'analytics']::text[],
       billing_mode = 'recurring',
       sort_order = 1
 where id = 'starter';

-- 3. Update Pro plan (₹2,499/mo, ₹24,990/yr, 100 QR codes maximum)
update public.subscription_plans
   set name = 'Pro',
       description = 'Complete restaurant management platform with live kitchen & analytics',
       price_monthly = 2499.00,
       price_yearly = 24990.00,
       currency = 'INR',
       trial_days = 14,
       is_active = true,
       is_popular = true,
       max_locations = 3,
       max_staff = 10,
       max_menu_items = 200,
       max_tables = 100,
       features = '[
         "100 QR codes maximum",
         "AI menu scanning with instant extraction",
         "QR ordering",
         "Kitchen display",
         "Up to 200 menu items",
         "Up to 3 restaurant locations",
         "Up to 10 staff members with roles",
         "Advanced analytics with multi-location insights and consolidated reporting",
         "Priority support"
       ]'::jsonb,
       feature_keys = array['pos', 'qr', 'orders', 'reports', 'kds', 'tables', 'staff', 'consolidated_billing', 'analytics']::text[],
       billing_mode = 'recurring',
       sort_order = 2
 where id = 'pro';

-- 4. Remove Enterprise (₹5,999) plan completely
delete from public.subscription_plans where id = 'enterprise';

-- 5. Atomic function to enforce table / QR code creation within plan limits
create or replace function public.create_table_within_limit(
  p_tenant_id uuid,
  p_limit integer,
  p_table jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_count integer;
  v_row public.tables%rowtype;
  v_token text;
begin
  -- Advisory transaction lock for tenant table writes
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 44));

  select count(*) into v_count
    from public.tables t
   where t.tenant_id = p_tenant_id;

  if v_count >= p_limit then
    return jsonb_build_object(
      'ok', false,
      'reason', 'limit',
      'count', v_count,
      'limit', p_limit
    );
  end if;

  v_token := coalesce(p_table->>'qr_token', encode(extensions.gen_random_bytes(9), 'hex'));

  begin
    insert into public.tables (
      tenant_id, name, seats, area, active, qr_token
    ) values (
      p_tenant_id,
      trim(p_table->>'name'),
      coalesce((p_table->>'seats')::integer, 4),
      coalesce(nullif(trim(p_table->>'area'), ''), 'Main Hall'),
      coalesce((p_table->>'active')::boolean, true),
      v_token
    )
    returning * into v_row;
  exception when unique_violation then
    return jsonb_build_object(
      'ok', false,
      'reason', 'duplicate',
      'error', 'A table with that name already exists'
    );
  end;

  return jsonb_build_object(
    'ok', true,
    'count', v_count + 1,
    'limit', p_limit,
    'table', to_jsonb(v_row)
  );
end;
$$;

revoke execute on function public.create_table_within_limit(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.create_table_within_limit(uuid, integer, jsonb) to service_role;


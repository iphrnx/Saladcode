-- Delete a restaurant's data without breaking the financial ledger.
--
-- `subscription_payments`, `billing_invoices` and `subscription_audit_logs`
-- reference the tenant with NO ACTION — deliberately, because invoices and
-- payments are records a business is required to keep. That is also why the
-- "delete restaurant" button could never work: a plain `delete from tenants`
-- fails the moment the restaurant has ever paid for anything.
--
-- So deletion removes everything the restaurant owns, and leaves a tombstone
-- row for the ledger to point at: name replaced, contact details and logo
-- gone, account inactive. The financial rows stay, stripped of any way back to
-- a person.

create or replace function public.purge_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_removed jsonb := '{}'::jsonb;
  v_count integer;
begin
  -- Restaurant data, children first where a cascade would not cover it.
  delete from public.order_items oi
   using public.orders o
   where oi.order_id = o.id and o.tenant_id = p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('order_items', v_count);

  delete from public.orders where tenant_id = p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('orders', v_count);

  delete from public.menu_items where tenant_id = p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('menu_items', v_count);

  delete from public.categories where tenant_id = p_tenant_id;
  delete from public.tables where tenant_id = p_tenant_id;
  delete from public.reservations where tenant_id = p_tenant_id;
  delete from public.promo_codes where tenant_id = p_tenant_id;
  delete from public.customer_reviews where tenant_id = p_tenant_id;
  delete from public.staff_activities where tenant_id = p_tenant_id;
  delete from public.staff_sessions where staff_id in (select id from public.staff where tenant_id = p_tenant_id);
  delete from public.staff where tenant_id = p_tenant_id;
  delete from public.roles where tenant_id = p_tenant_id;
  delete from public.settings where tenant_id = p_tenant_id;
  delete from public.security_logs where tenant_id = p_tenant_id;
  delete from public.daily_tenant_metrics where tenant_id = p_tenant_id;
  delete from public.feature_usage where tenant_id = p_tenant_id;
  delete from public.subscription_checkouts where tenant_id = p_tenant_id;
  delete from public.renewal_reminders where tenant_id = p_tenant_id;
  delete from public.support_issues where tenant_id = p_tenant_id;
  delete from public.tenant_notes where tenant_id = p_tenant_id;
  delete from public.table_sessions where tenant_id = p_tenant_id;

  -- Profiles last: the owner's identity goes with the account.
  delete from public.profiles where tenant_id = p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('profiles', v_count);

  -- The tombstone the ledger points at. Everything that could identify the
  -- restaurant or reach a person is cleared; the row itself remains.
  update public.tenants
     set name = 'Deleted restaurant',
         slug = 'deleted-' || replace(p_tenant_id::text, '-', ''),
         logo = null,
         tagline = null,
         address = null,
         phone = null,
         email = null,
         active = false,
         onboarding_done = false,
         subscription_status = 'none',
         subscription_plan = null,
         plan = 'starter',
         trial_started_at = null,
         trial_ends_at = null,
         current_period_end = null,
         payment_mode = null
   where id = p_tenant_id;

  return v_removed;
end;
$function$;

revoke execute on function public.purge_tenant(uuid) from public, anon, authenticated;
grant execute on function public.purge_tenant(uuid) to service_role;

-- ============================================================================
-- Migration: 20261128000003_refund_reconciliation_resolution.sql
-- Purpose:
--   1. Preserve unknown refund amounts (NULL) on subscription_refund_reconciliations
--      instead of substituting the full payment amount.
--   2. Add resolved_refund_id / resolved_at linkage on
--      subscription_refund_reconciliations so verified follow-ups resolve
--      matching pending entries strictly by verified identity (never by amount).
--   3. Provide idempotent resolve_pending_refund_reconciliation RPC.
-- ============================================================================

alter table public.subscription_refund_reconciliations
  alter column amount drop not null,
  alter column amount drop default;

alter table public.subscription_refund_reconciliations
  add column if not exists resolved_refund_id uuid references public.subscription_refunds(id) on delete set null,
  add column if not exists resolved_at timestamptz;

create index if not exists subscription_refund_reconciliations_resolved_idx
  on public.subscription_refund_reconciliations (resolved_refund_id)
  where resolved_refund_id is not null;

create or replace function public.record_subscription_refund(
  p_tenant_id            uuid,
  p_razorpay_payment_id  text,
  p_razorpay_refund_id   text,
  p_refund_amount        numeric,
  p_currency             text,
  p_refund_status        text,
  p_webhook_event_id     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment         record;
  v_tenant_plan     text;
  v_existing        record;
  v_refund_uuid     uuid;
  v_now             timestamptz := now();
  v_raw_amt         numeric(10, 2) := case when p_refund_amount > 0 then p_refund_amount end;
  v_effective_amt   numeric(10, 2);
  v_total_refunded  numeric(10, 2);
  v_fully_refunded  boolean;
  v_refund_id       text := nullif(btrim(coalesce(p_razorpay_refund_id, '')), '');
begin
  if p_tenant_id is null or length(btrim(coalesce(p_razorpay_payment_id, ''))) = 0 then
    return jsonb_build_object('outcome', 'ignore', 'reason', 'missing tenant or payment id');
  end if;

  if p_refund_status not in ('pending', 'processed', 'failed') then
    return jsonb_build_object('outcome', 'ignore', 'reason', 'unsupported refund status');
  end if;

  select *
    into v_payment
    from public.subscription_payments
   where razorpay_payment_id = p_razorpay_payment_id
     and tenant_id = p_tenant_id
     for update;

  if not found then
    return jsonb_build_object('outcome', 'payment_not_found', 'reason', 'payment row not found');
  end if;

  select coalesce(subscription_plan, plan)
    into v_tenant_plan
    from public.tenants
   where id = p_tenant_id;

  -- Events without a verified provider refund ID cannot be tied to a verified
  -- refund: preserve unknown amounts as NULL and keep them pending reconciliation.
  if v_refund_id is null or v_raw_amt is null or v_raw_amt <= 0 then
    insert into public.subscription_refund_reconciliations (
      tenant_id,
      payment_id,
      razorpay_payment_id,
      amount,
      currency,
      status,
      webhook_event_id,
      created_at,
      updated_at
    ) values (
      p_tenant_id,
      v_payment.id,
      p_razorpay_payment_id,
      v_raw_amt,
      coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
      'pending_reconciliation',
      p_webhook_event_id,
      v_now,
      v_now
    )
    on conflict (webhook_event_id) do nothing;

    return jsonb_build_object(
      'outcome', 'pending_reconciliation',
      'payment_uuid', v_payment.id,
      'amount', v_raw_amt
    );
  end if;

  v_effective_amt := v_raw_amt;
  if v_effective_amt > v_payment.amount
     or (nullif(btrim(p_currency), '') is not null and upper(btrim(p_currency)) <> upper(v_payment.currency)) then
    return jsonb_build_object('outcome', 'identity_mismatch', 'reason', 'refund amount or currency does not match payment');
  end if;

  select *
    into v_existing
    from public.subscription_refunds
   where razorpay_refund_id = v_refund_id
     for update;

  if found then
    if v_existing.tenant_id is distinct from p_tenant_id
       or v_existing.payment_id is distinct from v_payment.id
       or v_existing.razorpay_payment_id is distinct from p_razorpay_payment_id
       or v_existing.amount is distinct from v_effective_amt then
      return jsonb_build_object('outcome', 'identity_mismatch', 'reason', 'refund does not match its recorded payment or amount');
    end if;
    v_refund_uuid := v_existing.id;
    if v_existing.status = 'processed' then
      -- Resolve any pending reconciliation tied to the same verified webhook_event_id.
      if p_webhook_event_id is not null then
        update public.subscription_refund_reconciliations
           set status = 'reconciled',
               resolved_refund_id = v_refund_uuid,
               resolved_at = coalesce(resolved_at, v_now),
               updated_at = v_now
         where tenant_id = p_tenant_id
           and payment_id = v_payment.id
           and status = 'pending_reconciliation'
           and webhook_event_id = p_webhook_event_id;
      end if;

      begin
        insert into public.subscription_audit_logs (
          tenant_id, old_plan, new_plan, change_type, razorpay_event_id, detail
        ) values (
          p_tenant_id,
          v_tenant_plan,
          v_payment.plan_id,
          'refunded',
          p_webhook_event_id,
          jsonb_build_object(
            'paymentId', p_razorpay_payment_id,
            'refundId', v_refund_id,
            'internalRefundId', v_refund_uuid::text,
            'totalRefunded', v_payment.refunded_amount,
            'isFullyRefunded', v_payment.status = 'refunded'
          )
        );
      exception when unique_violation then
        null;
      end;

      return jsonb_build_object(
        'outcome', 'already_processed',
        'payment_uuid', v_payment.id,
        'refund_uuid', v_refund_uuid,
        'razorpay_refund_id', v_refund_id,
        'total_refunded', v_payment.refunded_amount,
        'is_fully_refunded', v_payment.status = 'refunded'
      );
    end if;

    if p_refund_status = 'pending' then
      return jsonb_build_object(
        'outcome', 'pending_recorded',
        'payment_uuid', v_payment.id,
        'refund_uuid', v_refund_uuid,
        'razorpay_refund_id', v_refund_id
      );
    end if;

    update public.subscription_refunds
       set status = p_refund_status,
           amount = v_effective_amt,
           currency = coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
           webhook_event_id = coalesce(p_webhook_event_id, webhook_event_id),
           processed_at = case when p_refund_status = 'processed' then v_now else processed_at end,
           updated_at = v_now
     where id = v_existing.id;
  else
    insert into public.subscription_refunds (
      tenant_id,
      payment_id,
      razorpay_payment_id,
      razorpay_refund_id,
      amount,
      currency,
      status,
      webhook_event_id,
      processed_at,
      created_at,
      updated_at
    ) values (
      p_tenant_id,
      v_payment.id,
      p_razorpay_payment_id,
      v_refund_id,
      v_effective_amt,
      coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
      p_refund_status,
      p_webhook_event_id,
      case when p_refund_status = 'processed' then v_now else null end,
      v_now,
      v_now
    )
    returning id into v_refund_uuid;
  end if;

  if p_refund_status = 'pending' then
    return jsonb_build_object(
      'outcome', 'pending_recorded',
      'payment_uuid', v_payment.id,
      'refund_uuid', v_refund_uuid,
      'razorpay_refund_id', v_refund_id
    );
  end if;

  if p_refund_status = 'failed' then
    return jsonb_build_object(
      'outcome', 'failed_recorded',
      'payment_uuid', v_payment.id,
      'refund_uuid', v_refund_uuid,
      'razorpay_refund_id', v_refund_id
    );
  end if;

  -- Resolve any pending reconciliation tied to this exact verified webhook_event_id.
  if p_webhook_event_id is not null then
    update public.subscription_refund_reconciliations
       set status = 'reconciled',
           resolved_refund_id = v_refund_uuid,
           resolved_at = coalesce(resolved_at, v_now),
           updated_at = v_now
     where tenant_id = p_tenant_id
       and payment_id = v_payment.id
       and status = 'pending_reconciliation'
       and webhook_event_id = p_webhook_event_id;
  end if;

  select coalesce(sum(amount), 0)::numeric(10, 2)
    into v_total_refunded
    from public.subscription_refunds
   where payment_id = v_payment.id
     and status = 'processed';

  v_fully_refunded := v_total_refunded + 0.005 >= v_payment.amount;

  update public.subscription_payments
     set refunded_amount = least(v_payment.amount, v_total_refunded),
         status = case
           when v_fully_refunded then 'refunded'
           else status
         end
   where id = v_payment.id;

  begin
    insert into public.subscription_audit_logs (
      tenant_id, old_plan, new_plan, change_type, razorpay_event_id, detail
    ) values (
      p_tenant_id,
      v_tenant_plan,
      v_payment.plan_id,
      'refunded',
      p_webhook_event_id,
      jsonb_build_object(
        'paymentId', p_razorpay_payment_id,
        'refundId', v_refund_id,
        'internalRefundId', v_refund_uuid::text,
        'totalRefunded', least(v_payment.amount, v_total_refunded),
        'isFullyRefunded', v_fully_refunded
      )
    );
  exception when unique_violation then
    null;
  end;

  return jsonb_build_object(
    'outcome', 'processed',
    'payment_uuid', v_payment.id,
    'refund_uuid', v_refund_uuid,
    'razorpay_refund_id', v_refund_id,
    'total_refunded', least(v_payment.amount, v_total_refunded),
    'is_fully_refunded', v_fully_refunded
  );
end;
$$;

revoke execute on function public.record_subscription_refund(uuid, text, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.record_subscription_refund(uuid, text, text, numeric, text, text, text) to service_role;

create or replace function public.resolve_pending_refund_reconciliation(
  p_reconciliation_id    uuid,
  p_razorpay_refund_id   text,
  p_refund_amount        numeric default null,
  p_currency             text default null,
  p_refund_status        text default 'processed',
  p_webhook_event_id     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rec       record;
  v_rpc_res   jsonb;
  v_refund_id uuid;
  v_now       timestamptz := now();
begin
  if p_reconciliation_id is null or length(btrim(coalesce(p_razorpay_refund_id, ''))) = 0 then
    return jsonb_build_object('outcome', 'ignore', 'reason', 'missing reconciliation id or verified refund id');
  end if;

  select *
    into v_rec
    from public.subscription_refund_reconciliations
   where id = p_reconciliation_id
     for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found', 'reason', 'reconciliation row not found');
  end if;

  if v_rec.status = 'reconciled' then
    if not exists (select 1 from public.subscription_refunds r
                   where r.id = v_rec.resolved_refund_id
                     and r.tenant_id = v_rec.tenant_id and r.payment_id = v_rec.payment_id
                     and r.razorpay_refund_id = p_razorpay_refund_id) then
      return jsonb_build_object('outcome', 'identity_mismatch');
    end if;
    return jsonb_build_object(
      'outcome', 'already_reconciled',
      'reconciliation_id', v_rec.id,
      'resolved_refund_id', v_rec.resolved_refund_id
    );
  end if;

  -- A new provider ID is not by itself evidence that this pending entry and
  -- that refund are the same event. Leave historical ambiguities pending.
  if p_webhook_event_id is null or p_webhook_event_id is distinct from v_rec.webhook_event_id
     or p_refund_amount is null or p_refund_amount <= 0 then
    return jsonb_build_object('outcome', 'verification_required');
  end if;

  v_rpc_res := public.record_subscription_refund(
    v_rec.tenant_id,
    v_rec.razorpay_payment_id,
    p_razorpay_refund_id,
    p_refund_amount,
    coalesce(p_currency, v_rec.currency),
    p_refund_status,
    coalesce(p_webhook_event_id, v_rec.webhook_event_id)
  );

  if (v_rpc_res->>'outcome') in ('processed', 'already_processed') then
    v_refund_id := nullif(v_rpc_res->>'refund_uuid', '')::uuid;
    update public.subscription_refund_reconciliations
       set status = 'reconciled',
           resolved_refund_id = v_refund_id,
           resolved_at = coalesce(resolved_at, v_now),
           updated_at = v_now
     where id = v_rec.id
       and status = 'pending_reconciliation';
  end if;

  return v_rpc_res || jsonb_build_object('reconciliation_id', v_rec.id);
end;
$$;

revoke execute on function public.resolve_pending_refund_reconciliation(uuid, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_pending_refund_reconciliation(uuid, text, numeric, text, text, text) to service_role;

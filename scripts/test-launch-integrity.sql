-- Run only on a disposable database with the launch migrations applied.
begin;
create function pg_temp.reject_fixture_settlement() returns trigger language plpgsql as $$
begin
  raise exception 'fixture storage failure';
end $$;
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  pending_id uuid;
  result jsonb;
  attempt integer;
  retry_attempt integer;
  fixture_table uuid;
  sitting uuid;
  sibling uuid;
  bill_id uuid;
  issued_invoice text;
  failed_attempt integer;
  newer_attempt integer;
  t timestamptz := '2026-11-28 01:00:00+00';
begin
  if has_function_privilege('anon','public.resolve_pending_refund_reconciliation(uuid,text,numeric,text,text,text)','execute')
     or has_function_privilege('authenticated','public.resolve_pending_refund_reconciliation(uuid,text,numeric,text,text,text)','execute')
     or not has_function_privilege('service_role','public.resolve_pending_refund_reconciliation(uuid,text,numeric,text,text,text)','execute') then
    raise exception 'unexpected reconciliation grants';
  end if;
  insert into public.tenants (id,name,slug) values (a,'Fixture A','launch-test-a'),(b,'Fixture B','launch-test-b');
  insert into public.subscription_payments (tenant_id,amount,status,razorpay_payment_id)
    values (a,100,'succeeded','pay_launch_a'),(b,100,'succeeded','pay_launch_b');
  result := public.record_subscription_refund(a,'pay_launch_a',null,null,'INR','processed','evt_launch_unknown');
  select id into strict pending_id from public.subscription_refund_reconciliations
    where webhook_event_id='evt_launch_unknown' and amount is null;
  if result->>'outcome' <> 'pending_reconciliation' then raise exception 'unknown amount finalized'; end if;
  result := public.resolve_pending_refund_reconciliation(pending_id,'rfnd_launch_1',20,'INR','processed','evt_wrong');
  if result->>'outcome' <> 'verification_required' then raise exception 'unverified resolution'; end if;
  result := public.resolve_pending_refund_reconciliation(pending_id,'rfnd_launch_1',20,'INR','processed','evt_launch_unknown');
  if result->>'outcome' <> 'processed' then raise exception 'verified resolution did not finalize: %', result; end if;
  perform public.record_subscription_refund(a,'pay_launch_a','rfnd_launch_1',20,'INR','processed','evt_launch_replay');
  perform public.record_subscription_refund(a,'pay_launch_a','rfnd_launch_2',20,'INR','processed','evt_launch_distinct');
  result := public.record_subscription_refund(b,'pay_launch_b','rfnd_launch_1',20,'INR','processed','evt_launch_other');
  if result->>'outcome' <> 'identity_mismatch'
     or (select refunded_amount from public.subscription_payments where razorpay_payment_id='pay_launch_a') <> 40
     or (select refunded_amount from public.subscription_payments where razorpay_payment_id='pay_launch_b') <> 0
     or (select count(*) from public.subscription_audit_logs where tenant_id=a and change_type='refunded') <> 2
     or not exists (select 1 from public.subscription_refund_reconciliations where id=pending_id and resolved_refund_id is not null and resolved_at is not null) then
    raise exception 'refund identity, ledger, or audit regression';
  end if;

  result := public.claim_subscription_delivery('evt_launch_first','subscription.charged','sub_launch',t);
  attempt := (result->>'attempt')::integer;
  if attempt is null then raise exception 'delivery not claimed'; end if;
  result := public.claim_subscription_delivery('evt_launch_next','subscription.paused','sub_launch',t+interval '1 hour');
  if result->>'status' <> 'in_progress' then raise exception 'newer delivery overtook unfinished work'; end if;
  if exists (select 1 from public.subscription_event_cursors where razorpay_subscription_id='sub_launch') then
    raise exception 'cursor advanced before completion';
  end if;
  update public.subscription_webhook_events set received_at=t where event_id='evt_launch_first';
  result := public.claim_subscription_delivery('evt_launch_first','subscription.charged','sub_launch',t);
  retry_attempt := (result->>'attempt')::integer;
  if retry_attempt is distinct from attempt+1
     or public.finish_subscription_delivery('evt_launch_first',attempt,true,'stale')
     or not public.finish_subscription_delivery('evt_launch_first',retry_attempt,true,'done') then
    raise exception 'delivery claim was not fenced';
  end if;
  if (select last_event_created_at from public.subscription_event_cursors where razorpay_subscription_id='sub_launch') is distinct from t then
    raise exception 'cursor did not advance with completion';
  end if;
  if has_function_privilege('authenticated','public.apply_subscription_delivery_state(text,integer,uuid,text,text,text,timestamptz,timestamptz)','execute')
     or has_function_privilege('anon','public.close_completed_order_sitting(uuid,uuid)','execute') then
    raise exception 'unexpected delivery state or sitting grants';
  end if;
  update public.tenants set razorpay_subscription_id='sub_launch', current_period_end=t+interval '30 days' where id=a;
  result := public.claim_subscription_delivery('evt_launch_failed','subscription.charged','sub_launch',t+interval '1 hour');
  failed_attempt := (result->>'attempt')::integer;
  if not public.finish_subscription_delivery('evt_launch_failed',failed_attempt,false,'provider timed out') then raise exception 'could not record retryable failure'; end if;
  result := public.claim_subscription_delivery('evt_launch_cancelled','subscription.cancelled','sub_launch',t+interval '2 hours');
  newer_attempt := (result->>'attempt')::integer;
  if newer_attempt is null then raise exception 'abandoned delivery blocked cancellation'; end if;
  if public.apply_subscription_delivery_state('evt_launch_cancelled',newer_attempt,a,'sub_launch',null,null,null,null) <> 'applied' then raise exception 'cancellation failed'; end if;
  if not public.finish_subscription_delivery('evt_launch_cancelled',newer_attempt,false,'email timed out after state commit') then raise exception 'could not record mail failure'; end if;
  result := public.claim_subscription_delivery('evt_launch_failed','subscription.charged','sub_launch',t+interval '1 hour');
  retry_attempt := (result->>'attempt')::integer;
  if retry_attempt is distinct from failed_attempt+1 then raise exception 'provider replay was not recoverable'; end if;
  if public.apply_subscription_delivery_state('evt_launch_failed',failed_attempt,a,'sub_launch','pro','monthly',t,t+interval '10 days') <> 'lost_claim' then raise exception 'expired worker can mutate state'; end if;
  if public.apply_subscription_delivery_state('evt_launch_failed',retry_attempt,a,'sub_launch','pro','monthly',t,t+interval '10 days') <> 'superseded' then raise exception 'late charge changed current entitlements'; end if;
  if not public.finish_subscription_delivery('evt_launch_failed',retry_attempt,true,'late charge recorded') then raise exception 'late ledger work cannot complete'; end if;
  result := public.claim_subscription_delivery('evt_launch_old_mandate','subscription.charged','sub_old_launch',t+interval '1 hour');
  if public.apply_subscription_delivery_state('evt_launch_old_mandate',(result->>'attempt')::integer,a,'sub_launch','pro','monthly',t,t+interval '10 days') <> 'superseded' then raise exception 'late prior mandate changed current entitlements'; end if;
  if not exists (select 1 from public.tenants where id=a and subscription_status='cancelled' and plan='starter'
    and current_period_end=t+interval '30 days' and cancel_at_period_end) then raise exception 'state regressed'; end if;
  result := public.claim_subscription_delivery('evt_launch_resume','subscription.resumed','sub_launch',t+interval '3 hours');
  newer_attempt := (result->>'attempt')::integer;
  if public.apply_subscription_delivery_state('evt_launch_resume',newer_attempt,a,'sub_launch',null,null,null,t+interval '31 days') <> 'applied' then raise exception 'valid later resume did not recover'; end if;

  insert into public.tables (tenant_id, name, qr_token) values (a,'Fixture table','qr_launch_fixture') returning id into fixture_table;
  insert into public.table_sessions (tenant_id, table_id, status) values (a,fixture_table,'ACTIVE') returning id into sitting;
  insert into public.table_checks (tenant_id, table_id, anchor_session_id, total) values (a,fixture_table,sitting,50) returning id into bill_id;
  insert into public.orders (tenant_id, table_id, table_session_id, check_id, status,total,items_total)
    values (a,fixture_table,sitting,bill_id,'SERVED',50,50) returning id into sibling;
  if public.close_completed_order_sitting(a,sitting) or public.close_completed_order_sitting(b,sitting) then
    raise exception 'sitting closed with a live sibling or by the wrong tenant';
  end if;
  update public.orders set status='COMPLETED' where id=sibling;
  insert into public.check_payments (tenant_id,check_id,amount,method,idempotency_key) values (a,bill_id,50,'CASH','fixture-settlement');
  create trigger reject_fixture_settlement before update on public.table_checks
    for each row execute function pg_temp.reject_fixture_settlement();
  begin
    perform public.close_completed_order_sitting(a,sitting);
    raise exception 'settlement incorrectly accepted injected failure';
  exception when raise_exception then
    if sqlerrm <> 'fixture storage failure' then raise; end if;
  end;
  drop trigger reject_fixture_settlement on public.table_checks;
  if not exists(select 1 from public.table_sessions where id=sitting and status='ACTIVE') then raise exception 'session closure did not roll back'; end if;
  if not public.close_completed_order_sitting(a,sitting) then raise exception 'first closure did not transition'; end if;
  select invoice_number into issued_invoice from public.table_checks where id=bill_id and status='PAID';
  if issued_invoice is null then raise exception 'retry did not finalize paid bill'; end if;
  if public.close_completed_order_sitting(a,sitting) then raise exception 'duplicate close transitioned'; end if;
  if (select invoice_number from public.table_checks where id=bill_id) is distinct from issued_invoice
    or (select count(*) from public.check_payments where check_id=bill_id) <> 1 then raise exception 'retry duplicated financial records'; end if;
  if not exists (select 1 from public.table_sessions where id=sitting and status='ENDED' and ended_at is not null) then
    raise exception 'closed sitting was not persisted';
  end if;
  raise notice 'launch integrity: refund, grants, cursor, lease fencing and sitting closure passed';
end $$;
rollback;

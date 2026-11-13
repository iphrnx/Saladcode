-- ===========================================================================
-- 0044 — billing integrity
--
-- Four defects this closes, each read out of the source first:
--
--   1. The webhook used the *event type* as the event id. `event_id` is the
--      primary key of `subscription_webhook_events`, so the first
--      `subscription.charged` was recorded and every later renewal, for every
--      restaurant, was rejected as a duplicate. Identity now comes from
--      Razorpay's per-delivery `x-razorpay-event-id` header, and the ordering of
--      events is tracked per subscription so a late delivery cannot undo a newer
--      state.
--
--   2. Nothing recorded what a checkout was *for*. `verify` had no order to
--      check against, so its ownership gate could be satisfied by any
--      client-supplied subscription id. `subscription_checkouts` is that record.
--
--   3. `verify` was replayable: each call moved the period 30 days forward.
--      A checkout row carries the payment that settled it, so the same payment
--      settles it once.
--
--   4. The menu and staff limits were counted in one statement and written in
--      another, and a failed count was read as "no limit". The two functions at
--      the end count and insert under one lock, in one transaction, and let an
--      error abort the whole thing — so a caller that cannot verify a limit
--      cannot write.
--
-- Backward compatible: nothing is dropped, nothing is renamed, and the columns
-- added to `subscription_webhook_events` are nullable. Rows already in that
-- table carry an event *type* in `event_id`; genuine ids are unique strings
-- (`evt_…`) so the two cannot collide, and those rows stay as a historical
-- record.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What a checkout was for.
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_checkouts (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  plan_id                  text not null,
  -- In the plan's own currency units (rupees), as the catalogue prices it. The
  -- payment's amount arrives in minor units and is compared after conversion.
  amount                   double precision not null,
  currency                 text not null,
  razorpay_order_id        text not null,
  razorpay_subscription_id text,
  status                   text not null default 'pending',
  razorpay_payment_id      text,
  verified_amount          double precision,
  verified_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint subscription_checkouts_status_check
    check (status in ('pending', 'paid', 'failed', 'expired'))
);

-- One checkout per order. This is what makes "the order is ours" answerable.
create unique index if not exists subscription_checkouts_order_key
  on public.subscription_checkouts (razorpay_order_id);

create index if not exists subscription_checkouts_tenant_idx
  on public.subscription_checkouts (tenant_id, created_at desc);

-- A payment settles one checkout.
create unique index if not exists subscription_checkouts_payment_key
  on public.subscription_checkouts (razorpay_payment_id)
  where razorpay_payment_id is not null;

alter table public.subscription_checkouts enable row level security;
-- No policies: the service role reaches it, nobody else. Same posture as
-- `super_admins` and `subscription_webhook_events`.

-- ---------------------------------------------------------------------------
-- Event identity and ordering.
-- ---------------------------------------------------------------------------
alter table public.subscription_webhook_events
  add column if not exists razorpay_subscription_id text,
  add column if not exists event_created_at timestamptz;

create index if not exists subscription_webhook_events_sub_idx
  on public.subscription_webhook_events (razorpay_subscription_id, event_created_at desc);

-- The newest event applied to each subscription. A delivery older than this is
-- recorded but not acted on, so a retry that arrives late cannot resurrect a
-- state the subscription has already left.
create table if not exists public.subscription_event_cursors (
  razorpay_subscription_id text primary key,
  last_event_created_at    timestamptz not null,
  updated_at               timestamptz not null default now()
);

alter table public.subscription_event_cursors enable row level security;

-- ---------------------------------------------------------------------------
-- apply_subscription_event — the idempotency and ordering gate, atomically.
--
-- Returns:
--   'applied'   — first time this delivery has been seen, and not stale
--   'duplicate' — this exact delivery has been handled before
--   'stale'     — a genuine, unseen delivery that is older than the state
--
-- Doing this in one function matters: the insert of the delivery and the read of
-- the cursor have to happen together, or two deliveries arriving at once can
-- both pass the check.
-- ---------------------------------------------------------------------------
create or replace function public.apply_subscription_event(
  p_event_id text,
  p_event_type text,
  p_subscription_id text,
  p_event_created_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor timestamptz;
begin
  if p_event_id is null or length(btrim(p_event_id)) = 0 then
    raise exception 'an event id is required';
  end if;

  insert into public.subscription_webhook_events (
    event_id, event_type, received_at, razorpay_subscription_id, event_created_at
  ) values (
    p_event_id, p_event_type, now(), p_subscription_id, p_event_created_at
  );

  if p_subscription_id is null then
    return 'applied';
  end if;

  select c.last_event_created_at into v_cursor
    from public.subscription_event_cursors c
   where c.razorpay_subscription_id = p_subscription_id
     for update;

  if v_cursor is not null
     and p_event_created_at is not null
     and p_event_created_at < v_cursor then
    return 'stale';
  end if;

  insert into public.subscription_event_cursors (
    razorpay_subscription_id, last_event_created_at, updated_at
  ) values (
    p_subscription_id, coalesce(p_event_created_at, now()), now()
  )
  on conflict (razorpay_subscription_id) do update
    set last_event_created_at = greatest(
          public.subscription_event_cursors.last_event_created_at,
          coalesce(excluded.last_event_created_at, now())
        ),
        updated_at = now();

  return 'applied';
exception
  when unique_violation then
    -- The primary key of the events table is the delivery id: a repeat delivery
    -- cannot be inserted, which is exactly the answer we want.
    return 'duplicate';
end;
$$;

revoke execute on function public.apply_subscription_event(text, text, text, timestamptz)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Counting and writing in the same transaction.
--
-- Each takes the row an edge function has already prepared (validated, priced,
-- hashed) and inserts it only if the restaurant is inside its plan. The advisory
-- lock is taken on the restaurant, so two requests for the same restaurant queue
-- behind each other and the second sees the first's row.
--
-- No exception handler: if the count cannot be read, the error aborts the
-- transaction and nothing is written. That is the point — a limit that cannot be
-- verified must not become a write that is allowed.
-- ---------------------------------------------------------------------------
create or replace function public.create_menu_item_within_limit(
  p_tenant_id uuid,
  p_limit integer,
  p_item jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_row public.menu_items;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 42));

  select count(*) into v_count
    from public.menu_items m
   where m.tenant_id = p_tenant_id;

  if v_count >= p_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'count', v_count, 'limit', p_limit);
  end if;

  insert into public.menu_items (
    tenant_id, category_id, name, description, price, image, available,
    prep_time, tags, calories, sort_order, rating, portions
  ) values (
    p_tenant_id,
    (p_item->>'category_id')::uuid,
    p_item->>'name',
    p_item->>'description',
    coalesce((p_item->>'price')::double precision, 0),
    p_item->>'image',
    coalesce((p_item->>'available')::boolean, true),
    coalesce((p_item->>'prep_time')::integer, 15),
    p_item->>'tags',
    nullif(p_item->>'calories', '')::integer,
    coalesce(nullif(p_item->>'sort_order', '')::integer, 0),
    coalesce(nullif(p_item->>'rating', '')::double precision, 4.5),
    case when p_item ? 'portions' then p_item->'portions' else null end
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'count', v_count + 1, 'limit', p_limit, 'item', to_jsonb(v_row));
end;
$$;

create or replace function public.create_staff_within_limit(
  p_tenant_id uuid,
  p_limit integer,
  p_staff jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_row public.staff;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 43));

  select count(*) into v_count
    from public.staff s
   where s.tenant_id = p_tenant_id;

  if v_count >= p_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'count', v_count, 'limit', p_limit);
  end if;

  insert into public.staff (
    tenant_id, name, employee_id, role_id, pin_hash, pin_salt, active, avatar
  ) values (
    p_tenant_id,
    p_staff->>'name',
    p_staff->>'employee_id',
    nullif(p_staff->>'role_id', '')::uuid,
    p_staff->>'pin_hash',
    p_staff->>'pin_salt',
    coalesce((p_staff->>'active')::boolean, true),
    p_staff->>'avatar'
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'count', v_count + 1, 'limit', p_limit, 'staff', to_jsonb(v_row));
end;
$$;

revoke execute on function public.create_menu_item_within_limit(uuid, integer, jsonb)
  from public, anon, authenticated;
revoke execute on function public.create_staff_within_limit(uuid, integer, jsonb)
  from public, anon, authenticated;

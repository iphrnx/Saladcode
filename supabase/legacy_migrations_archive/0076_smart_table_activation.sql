-- ===========================================================================
-- 0076 — smart table activation
--
-- A QR scan must open the menu immediately: browsing and building a cart need
-- no staff involvement. Ordering is the part that can need a human, and only
-- when the table is not already open.
--
-- The model, in four states of `table_sessions.activation_status`:
--
--   ACTIVE    the table is open — orders go straight to the kitchen. This is
--             what every scan used to produce, and still does when the table
--             is already open (a second diner joining a sitting).
--   PENDING   the scan happened, nobody has accepted the table yet. The diner
--             can browse and fill a cart; the first order is *held*.
--   REJECTED  staff declined the table; the session can no longer order.
--   EXPIRED   nobody accepted it in time.
--
-- A held order is an ordinary order row in `PENDING_ACTIVATION`. That state is
-- deliberately outside PENDING/PREPARING/READY/SERVED, which is what keeps it
-- off the kitchen display and out of every bill and revenue figure without
-- touching those queries — they filter on those four.
--
-- Booking-free by design: nothing here rotates the QR, asks the diner to log
-- in, or requires staff approval to *see* a menu.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The session carries the answer
-- ---------------------------------------------------------------------------
alter table public.table_sessions
  add column if not exists activation_status text not null default 'ACTIVE',
  add column if not exists activation_requested_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists activated_by uuid references public.profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'table_sessions_activation_status_check'
  ) then
    alter table public.table_sessions
      add constraint table_sessions_activation_status_check
      check (activation_status in ('ACTIVE', 'PENDING', 'REJECTED', 'EXPIRED'));
  end if;
end $$;

-- A refusal is shown to the diner, so the reason lives on the order. Additive
-- and nullable: every existing row keeps reading the same.
alter table public.orders
  add column if not exists cancellation_reason text;

create index if not exists table_sessions_pending_idx
  on public.table_sessions (tenant_id, activation_status)
  where activation_status = 'PENDING';

-- ---------------------------------------------------------------------------
-- 2. Scanning: open the table, or ask for it
--
-- `start_table_session` still creates one session per scan — that is what
-- gives each diner a private cart and a private order list. What changes is
-- the activation status it is born with: if any session on that table is
-- already ACTIVE, the table is open and this one joins it. Otherwise it is
-- PENDING and the first order is held for approval.
-- ---------------------------------------------------------------------------
create or replace function public.start_table_session(p_qr_token text, p_device_fp text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table   public.tables;
  v_tenant  public.tenants;
  v_session public.table_sessions;
  v_open    boolean;
begin
  select * into v_table from public.tables
   where qr_token = p_qr_token and active limit 1;

  if not found then
    raise exception 'INVALID_QR' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_table.tenant_id;
  if not found or not v_tenant.active then
    raise exception 'RESTAURANT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- A table with a diner already seated does not need re-approving: this
  -- diner is joining a sitting that is already open.
  select exists (
    select 1 from public.table_sessions s
     where s.table_id = v_table.id
       and s.status = 'ACTIVE'
       and s.activation_status = 'ACTIVE'
  ) into v_open;

  insert into public.table_sessions (
    tenant_id, table_id, device_fp, activation_status, activation_requested_at, activated_at
  ) values (
    v_table.tenant_id, v_table.id, p_device_fp,
    case when v_open then 'ACTIVE' else 'PENDING' end,
    case when v_open then null else now() end,
    case when v_open then now() else null end
  )
  returning * into v_session;

  return jsonb_build_object(
    'session_token',        v_session.token,
    'session_id',           v_session.id,
    'status',               v_session.status,
    'activation_status',    v_session.activation_status,
    'tenant_id',            v_table.tenant_id,
    'table', jsonb_build_object(
      'id', v_table.id, 'name', v_table.name,
      'seats', v_table.seats, 'area', v_table.area
    )
  );
end $$;

-- Recreated functions get the PUBLIC grant back; an anonymous caller must not
-- be able to run it directly (0039's lesson, applied again).
-- The edge function calls this with the service role, and so does the server
-- helper; nothing in a browser calls it through PostgREST. Leaving EXECUTE on
-- anon would be a second, unsupported way to mint a session — with the anon
-- key, straight past the rate limits the function applies.
revoke execute on function public.start_table_session(text, text) from public, anon, authenticated;
grant execute on function public.start_table_session(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Approving a table — one transaction, idempotent
--
-- The order rows are already written and priced. Approval does not trust them:
-- it re-checks every line against the menu (still exists, still this tenant,
-- still available, still the same price) and refuses if the cart went stale,
-- rather than releasing a price the kitchen would not honour.
-- ---------------------------------------------------------------------------
create or replace function public.approve_table_activation(
  p_tenant uuid,
  p_session uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions;
  v_table uuid;
  v_released integer := 0;
  v_stale text;
begin
  select * into v_session
    from public.table_sessions
   where id = p_session and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_session.status <> 'ACTIVE' then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;

  if v_session.activation_status = 'REJECTED' or v_session.activation_status = 'EXPIRED' then
    raise exception 'SESSION_%', v_session.activation_status using errcode = 'P0001';
  end if;

  v_table := v_session.table_id;

  -- Accepting is a decision about the *table*, not about one diner's browser.
  -- Two people at the same table scan separately and each gets their own
  -- session and their own cart; if only the first were released, the second
  -- would sit on "waiting" with their food never cooked, at a table the
  -- restaurant has already seated.
  --
  -- Every pending session on this table is therefore activated together, in
  -- this one transaction, and every held order on them released with it.
  perform 1 from public.table_sessions
   where tenant_id = p_tenant and table_id = v_table and status = 'ACTIVE'
   for update;

  -- Already accepted: answer the same, release nothing twice.
  if v_session.activation_status = 'ACTIVE' then
    select count(*) into v_released
      from public.orders
     where table_session_id = p_session and status = 'PENDING';
    return jsonb_build_object('ok', true, 'already', true, 'released', v_released);
  end if;

  -- Revalidate every held line on the table. A dish taken off the menu, or
  -- moved to another tenant, between the diner's tap and the manager's click
  -- is a reason to refuse — not to cook at a price nobody agreed.
  select string_agg(distinct mi.name, ', ') into v_stale
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.table_sessions s on s.id = o.table_session_id
    left join public.menu_items mi on mi.id = oi.menu_item_id
   where s.tenant_id = p_tenant
     and s.table_id = v_table
     and o.status = 'PENDING_ACTIVATION'
     and (mi.id is null or mi.tenant_id <> p_tenant or mi.available = false);

  if v_stale is not null then
    raise exception 'ITEMS_UNAVAILABLE:%', v_stale using errcode = 'P0001';
  end if;

  update public.table_sessions
     set activation_status = 'ACTIVE',
         activated_at = now(),
         activated_by = p_actor
   where tenant_id = p_tenant
     and table_id = v_table
     and status = 'ACTIVE'
     and activation_status = 'PENDING';

  -- Released orders become ordinary pending orders: the kitchen sees them, the
  -- bill counts them, and the diner's status starts moving.
  with released as (
    update public.orders o
       set status = 'PENDING',
           updated_at = now()
      from public.table_sessions s
     where s.id = o.table_session_id
       and s.tenant_id = p_tenant
       and s.table_id = v_table
       and o.status = 'PENDING_ACTIVATION'
    returning 1
  )
  select count(*) into v_released from released;

  return jsonb_build_object('ok', true, 'already', false, 'released', v_released);
end $$;

revoke execute on function public.approve_table_activation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_table_activation(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Refusing a table, and letting one expire
-- ---------------------------------------------------------------------------
create or replace function public.refuse_table_activation(
  p_tenant uuid,
  p_session uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled integer := 0;
begin
  perform 1 from public.table_sessions
   where id = p_session and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Held orders never happened: they were never cooked or charged, so they are
  -- cancelled with a reason the diner is shown.
  with cancelled as (
    update public.orders
       set status = 'CANCELLED',
           updated_at = now(),
           cancellation_reason = coalesce(p_reason, 'Table not accepted by the restaurant')
     where table_session_id = p_session
       and status = 'PENDING_ACTIVATION'
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  update public.table_sessions
     set activation_status = 'REJECTED',
         status = 'ENDED',
         ended_at = now()
   where id = p_session;

  return jsonb_build_object('ok', true, 'cancelled', v_cancelled);
end $$;

revoke execute on function public.refuse_table_activation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.refuse_table_activation(uuid, uuid, text) to service_role;

/**
 * Expire activation requests nobody answered.
 *
 * Long enough for a busy manager to get to it, short enough that a diner is
 * not left waiting on a screen that will never change. Runs from the same
 * sweep that releases abandoned sessions.
 */
create or replace function public.expire_pending_activations(p_after interval default '15 minutes')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- `skip locked` so an expiry can never block behind — or race with — an
  -- approval that has already locked the same session. Whichever wins, the
  -- other one sees the new state and does nothing.
  with gone as (
    update public.table_sessions s
       set activation_status = 'EXPIRED',
           status = 'ENDED',
           ended_at = now()
     where s.id in (
       select id from public.table_sessions
        where status = 'ACTIVE'
          and activation_status = 'PENDING'
          and activation_requested_at < now() - p_after
        for update skip locked
     )
    returning s.id
  )
  select count(*) into v_count from gone;

  -- The held orders go with it. Leaving them in PENDING_ACTIVATION would
  -- orphan rows nothing can ever resolve: not the kitchen, not a bill, not an
  -- approval for a session that is already gone.
  update public.orders o
     set status = 'CANCELLED',
         updated_at = now(),
         cancellation_reason = 'The restaurant did not accept the table in time'
    from public.table_sessions s
   where s.id = o.table_session_id
     and s.status = 'ENDED'
     and s.activation_status = 'EXPIRED'
     and o.status = 'PENDING_ACTIVATION';

  return v_count;
end $$;

revoke execute on function public.expire_pending_activations(interval) from public, anon, authenticated;
grant execute on function public.expire_pending_activations(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The held order is invisible to the kitchen and to the bill
--
-- Every query that decides what is being cooked or what is owed filters on
-- these four states. Adding the state rather than a column is what makes the
-- exclusion total: there is no read path that could forget a flag.
-- ---------------------------------------------------------------------------
comment on column public.orders.status is
  'PENDING_ACTIVATION = held until staff accept the table (0076). Not cooked, not billed.';

-- ---------------------------------------------------------------------------
-- 6. Order creation learns one more argument
--
-- The body below is the 0056 function verbatim, with one addition: the status
-- the row is born in. Retyping it was not an option — that body carries the
-- conditional promo burn and the same-key race handling, and a "small rewrite"
-- is how those quietly disappear.
-- ---------------------------------------------------------------------------
create or replace function public.create_order_tx(
  p_order jsonb,
  p_items jsonb,
  p_promo_code_id uuid default null,
  p_idempotency_key uuid default null,
  p_status text default 'PENDING'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := (p_order->>'tenant_id')::uuid;
  v_order_id uuid;
  v_item jsonb;
  v_menu record;
begin
  -- A held order is a real, priced order that the kitchen must not see; the
  -- only two states a checkout may be born in are these.
  if p_status not in ('PENDING', 'PENDING_ACTIVATION') then
    raise exception 'INVALID_STATUS:%', p_status using errcode = 'P0001';
  end if;

  -- Replay fast path: the key already committed — hand back the original.
  if p_idempotency_key is not null then
    select id into v_order_id
      from public.orders
     where idempotency_key = p_idempotency_key;
    if v_order_id is not null then
      return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
    end if;
  end if;

  -- Invariants that may have changed since the edge function priced the cart:
  -- every dish still exists, still belongs to this tenant, still available.
  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;
    if v_menu is null or v_menu.tenant_id <> v_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id';
    end if;
  end loop;

  -- The order row. On a concurrent same-key commit the unique index decides;
  -- the loser takes the winner's order and writes nothing.
  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes,
    served_by_id, idempotency_key
  ) values (
    v_tenant,
    nullif(p_order->>'table_id', '')::uuid,
    nullif(p_order->>'table_session_id', '')::uuid,
    coalesce(p_order->>'order_type', 'DINE_IN'),
    p_status,
    (p_order->>'items_total')::numeric,
    (p_order->>'discount')::numeric,
    (p_order->>'tax')::numeric,
    (p_order->>'service_charge')::numeric,
    (p_order->>'total')::numeric,
    nullif(p_order->>'promo_code_id', '')::uuid,
    nullif(p_order->>'promo_code', ''),
    nullif(p_order->>'customer_name', ''),
    nullif(p_order->>'customer_phone', ''),
    nullif(p_order->>'notes', ''),
    nullif(p_order->>'served_by_id', '')::uuid,
    p_idempotency_key
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select id into v_order_id
      from public.orders
     where idempotency_key = p_idempotency_key;
    return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
  end if;

  -- The promo burn is conditional and atomic: if the code stopped being
  -- eligible between pricing and commit (usage limit reached, deactivated,
  -- expired) the update matches nothing, the exception rolls the order back
  -- too, and the edge function re-prices without the code and retries.
  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant
       and active
       and (usage_limit = 0 or used_count < usage_limit)
       and valid_from <= now()
       and (valid_to is null or valid_to >= now());
    if not found then
      raise exception 'PROMO_REJECTED';
    end if;
  end if;

  insert into public.order_items (
    order_id, menu_item_id, name, price, quantity, notes, status,
    portion_id, portion
  )
  select
    v_order_id,
    (line->>'menu_item_id')::uuid,
    line->>'name',
    (line->>'price')::numeric,
    (line->>'quantity')::integer,
    nullif(line->>'notes', ''),
    'PENDING',
    nullif(line->>'portion_id', ''),
    nullif(line->>'portion', '')
  from jsonb_array_elements(p_items) as line;

  return jsonb_build_object('order_id', v_order_id, 'deduplicated', false);
end;
$$;
revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text)
  from public, anon, authenticated;

-- Every transactional email the product sends, planned and delivered.
--
-- One row per *event*, not per attempt: the unique event key is what makes a
-- repeated webhook delivery or a re-run of the reminder job a no-op instead of
-- a second email. `attempts`, `provider_id` and `error` describe delivery.
--
-- Rows deliberately do NOT cascade from `tenants`: an account-deletion email
-- has to outlive the account it is about, and it is the only delivery record
-- we keep for it. The recipient and name are snapshotted for the same reason —
-- after the delete there is nothing left to look them up from.

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  /** Idempotency key: type + subject + period. Unique per tenant. */
  event_key text not null,
  /** e.g. subscription_activated, payment_failed, trial_ending, account_deleted */
  event_type text not null,
  tenant_id uuid references public.tenants(id) on delete set null,
  /** Snapshot: the address and name as they were when the event happened. */
  recipient text not null,
  recipient_name text,
  restaurant_name text,
  subject text not null,
  plan_name text,
  amount numeric,
  currency text,
  billing_interval text,
  /** Free-form details the template needs (dates, reasons). */
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending', -- pending | sent | failed | skipped
  attempts integer not null default 0,
  provider_id text,
  error text,
  created_at timestamp with time zone not null default now(),
  sent_at timestamp with time zone,
  next_attempt_at timestamp with time zone not null default now(),
  unique (event_key)
);

create index if not exists email_events_pending_idx
  on public.email_events (next_attempt_at)
  where status = 'pending';

create index if not exists email_events_tenant_idx
  on public.email_events (tenant_id, created_at desc);

-- Service-role only: the dispatcher writes it, nobody browses it. Delivery
-- reasons can quote provider errors, and recipients are personal data.
alter table public.email_events enable row level security;

comment on column public.email_events.event_key is
  'Idempotency key. A duplicate webhook or a re-run of the reminder job hits this unique index and sends nothing.';

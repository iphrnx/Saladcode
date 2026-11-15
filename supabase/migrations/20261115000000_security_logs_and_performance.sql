-- Migration: 20261115000000_security_logs_and_performance.sql
-- Description: Add actor_staff_id to security_logs, index foreign keys, and secure trigger execution.

-- 1. Sync actor_staff_id column on security_logs
alter table public.security_logs
  add column if not exists actor_staff_id uuid references public.staff(id) on delete set null;

update public.security_logs
   set actor_staff_id = staff_id
 where actor_staff_id is null and staff_id is not null;

update public.security_logs
   set staff_id = actor_staff_id
 where staff_id is null and actor_staff_id is not null;

-- 2. Covering indexes for unindexed foreign keys
create index if not exists idx_customer_reviews_table_id
  on public.customer_reviews(table_id);

create index if not exists idx_security_logs_actor_staff_id
  on public.security_logs(actor_staff_id);

-- 3. Automatic bi-directional synchronization trigger for security_logs staff columns
create or replace function public.trg_sync_security_logs_staff_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.actor_staff_id is null and new.staff_id is not null then
    new.actor_staff_id := new.staff_id;
  elsif new.staff_id is null and new.actor_staff_id is not null then
    new.staff_id := new.actor_staff_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.trg_sync_security_logs_staff_id() from public, anon, authenticated;

drop trigger if exists trg_sync_security_logs_staff_id on public.security_logs;
create trigger trg_sync_security_logs_staff_id
before insert or update on public.security_logs
for each row execute function public.trg_sync_security_logs_staff_id();

-- 4. Revoke public/anon/authenticated execution on trigger function
revoke execute on function public.trg_sync_order_items_status() from public, anon, authenticated;

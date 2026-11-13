-- ===========================================================================
-- 0082 — a finalised invoice cannot be changed, at the database level
--
-- Until now "immutable" meant the endpoint refused to change it. That is a
-- statement about one code path, not about the record: a future function, a
-- data fix, or a bad migration could still rewrite the amount on a bill that
-- has already been handed to a customer and reported as revenue.
--
-- The trigger below makes it a property of the row. Corrections are not
-- forbidden — they are just not edits: a refund is a new record, and a void is
-- a status change that leaves every figure alone.
-- ===========================================================================

create or replace function public.guard_finalised_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'PAID' then
      raise exception 'INVOICE_IMMUTABLE: a finalised invoice cannot be deleted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- Everything that is on the paper. Status changes from PAID to something
  -- else are refused too: un-paying an invoice is how revenue disappears.
  if old.status = 'PAID' then
    if new.status is distinct from old.status
       or new.total is distinct from old.total
       or new.subtotal is distinct from old.subtotal
       or new.tax is distinct from old.tax
       or new.discount is distinct from old.discount
       or new.service_charge is distinct from old.service_charge
       or new.paid_total is distinct from old.paid_total
       or new.invoice_number is distinct from old.invoice_number
       or new.invoice_date is distinct from old.invoice_date
       or new.closed_at is distinct from old.closed_at then
      raise exception 'INVOICE_IMMUTABLE: invoice % cannot be modified', old.invoice_number
        using errcode = 'P0001';
    end if;

    -- Touching the timestamp is allowed for a non-financial note, but the
    -- figures above are not, so nothing here can alter what was billed.
    return new;
  end if;

  return new;
end $$;

drop trigger if exists table_checks_finalised_immutable on public.table_checks;
create trigger table_checks_finalised_immutable
  before update or delete on public.table_checks
  for each row execute function public.guard_finalised_check();

/**
 * A payment on an invoiced bill is a receipt, not a draft.
 *
 * Its amount, method and target are fixed. `status` stays writable so a refund
 * can be recorded as a new fact about that payment rather than by rewriting
 * what happened — and the check's paid_total is frozen with the invoice, so the
 * refund lives in the ledger without moving a number that has been reported.
 */
create or replace function public.guard_finalised_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.table_checks where id = coalesce(new.check_id, old.check_id);

  if v_status = 'PAID' then
    if tg_op = 'DELETE' then
      raise exception 'INVOICE_IMMUTABLE: a payment on an invoiced bill cannot be deleted'
        using errcode = 'P0001';
    end if;
    if new.amount is distinct from old.amount
       or new.method is distinct from old.method
       or new.check_id is distinct from old.check_id then
      raise exception 'INVOICE_IMMUTABLE: a payment on an invoiced bill cannot be altered'
        using errcode = 'P0001';
    end if;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists check_payments_finalised_immutable on public.check_payments;
create trigger check_payments_finalised_immutable
  before update or delete on public.check_payments
  for each row execute function public.guard_finalised_payment();

comment on function public.guard_finalised_check() is
  'A PAID check is immutable: figures, number and status are frozen (0082).';

-- Generated tables take one honest default: Main Hall, 4 seats.
--
-- Onboarding used to give every generated table an invented area and seat count
-- — Main Hall for the first four then Terrace, and 2/4/6 seats by position — so
-- the owner had to correct them one table at a time and the QR cards printed
-- those invented values as if they were real.
--
-- This corrects only rows that still carry the generator's exact signature:
--
--   * the name is exactly "Table <n>" (no renaming),
--   * seats and area are precisely what the generator produced for that n,
--   * and the row shares its created_at with at least one other table in the
--     same tenant, because onboarding inserts the whole batch in a single
--     statement (one transaction timestamp).
--
-- Anything an owner edited breaks one of those conditions and is left alone:
-- a renamed table, a seat count they changed, an area they set, or a table they
-- added later (which has its own timestamp). QR tokens, ids and sessions are
-- not touched.

with generated as (
  select t.id,
         substring(t.name from '^Table ([0-9]+)$')::int as n
    from public.tables t
   where t.name ~ '^Table [0-9]+$'
)
update public.tables t
   set seats = 4,
       area  = 'Main Hall'
  from generated g
 where g.id = t.id
   and g.n between 1 and 200
   and t.seats = case when g.n <= 2 then 2 when g.n <= 6 then 4 else 6 end
   and t.area  = case when g.n <= 4 then 'Main Hall' else 'Terrace' end
   and exists (
     select 1
       from public.tables sib
      where sib.tenant_id = t.tenant_id
        and sib.id <> t.id
        and sib.created_at = t.created_at
   );

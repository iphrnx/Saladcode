-- `security_logs.user_id` was declared as a bare uuid with no foreign key.
-- PostgREST resolves embedded selects through real FK constraints, so
-- `/api/bootstrap` failed with:
--   "Could not find a relationship between 'security_logs' and 'profiles'"
-- (The other *_id columns without FKs — google_connections.location_id /
--  place_id, google_reviews.google_review_id, staff.employee_id — are
--  external identifiers or usernames and correctly have none.)

alter table public.security_logs
  add constraint security_logs_user_fk
  foreign key (user_id) references public.profiles(id) on delete set null;

-- Ask PostgREST to pick up the new relationship immediately.
notify pgrst, 'reload schema';

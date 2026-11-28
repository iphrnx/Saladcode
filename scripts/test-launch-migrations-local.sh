#!/usr/bin/env bash
# Disposable, network-isolated migration rehearsal. Requires Docker and the
# pinned local Supabase images; never accepts an external database URL.
set -euo pipefail
cd "$(dirname "$0")/.."
mode=${1:-fresh}
[[ "$mode" == fresh || "$mode" == upgrade ]] || { echo 'Usage: bash scripts/test-launch-migrations-local.sh [fresh|upgrade]' >&2; exit 2; }
prefix="saladcode-launch-$mode-$$"
db="$prefix-db"; auth="$prefix-auth"; storage="$prefix-storage"
trap 'docker rm -fv "$storage" "$auth" "$db" >/dev/null 2>&1 || true' EXIT
for image in postgres:17.11.0.018 gotrue:v2.198.0 storage-api:v1.98.0; do
  docker image inspect "public.ecr.aws/supabase/$image" >/dev/null
done
docker run --pull never -d --rm --name "$db" --network none \
  -e POSTGRES_PASSWORD=isolated-local-only public.ecr.aws/supabase/postgres:17.11.0.018 >/dev/null
sql() { docker exec -i "$db" psql -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
wait_for() {
  for ((i=0;i<45;i++)); do
    if sql -Atc "$1" 2>/dev/null | grep -qx t; then return 0; fi
    sleep 1
  done
  docker logs --tail 8 "$auth" 2>&1 || true
  docker logs --tail 8 "$storage" 2>&1 || true
  return 1
}
for ((i=0;i<45;i++)); do
  if docker exec "$db" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$db" pg_isready -h 127.0.0.1 -U postgres
wait_for "select exists (select 1 from pg_roles where rolname='supabase_storage_admin')"
docker run --pull never -d --name "$auth" --network "container:$db" \
  -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:isolated-local-only@127.0.0.1:5432/postgres \
  -e GOTRUE_SITE_URL=http://localhost -e API_EXTERNAL_URL=http://localhost \
  -e GOTRUE_JWT_SECRET=isolated-local-only-jwt-not-for-production -e GOTRUE_API_HOST=127.0.0.1 -e GOTRUE_API_PORT=9999 \
  public.ecr.aws/supabase/gotrue:v2.198.0 >/dev/null
docker run --pull never -d --rm --name "$storage" --network "container:$db" \
  -e DATABASE_URL=postgres://supabase_storage_admin:isolated-local-only@127.0.0.1:5432/postgres \
  -e PGRST_JWT_SECRET=isolated-local-only-jwt-not-for-production -e ANON_KEY=isolated-anon -e SERVICE_KEY=isolated-service \
  -e POSTGREST_URL=http://localhost:3000 -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/tmp/isolated-data \
  -e TENANT_ID=stub -e REGION=local -e GLOBAL_S3_BUCKET=stub -e FILE_SIZE_LIMIT=52428800 \
  public.ecr.aws/supabase/storage-api:v1.98.0 >/dev/null
wait_for "select to_regclass('auth.sessions') is not null and to_regclass('storage.buckets') is not null"
sql -qc 'create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);'
dupes=$(find supabase/migrations -name '*.sql' -exec basename '{}' \; | cut -d_ -f1 | sort | uniq -d)
[[ -z "$dupes" ]] || { echo "Duplicate migration versions: $dupes" >&2; exit 1; }
for migration in supabase/migrations/*.sql; do
  if [[ "$mode" == upgrade && "${migration##*/}" == 20261128000003_* ]]; then
    sql -qc "insert into public.tenants (id,name,slug) values ('00000000-0000-4000-8000-000000000031','Upgrade sentinel','upgrade-sentinel'); insert into public.subscription_payments (tenant_id,amount,status,razorpay_payment_id) values ('00000000-0000-4000-8000-000000000031',100,'succeeded','pay_upgrade_sentinel');"
  fi
  echo "APPLY ${migration##*/}"
  sql -q -1 < "$migration"
done
echo 'SEED'
sql -q -1 < supabase/seed.sql
sql -Atc "select (select count(*) from public.tables) = 4 and (select count(*) from public.menu_items) = 4 and to_regclass('public.reservations') is null" | grep -qx t
if [[ "$mode" == upgrade ]]; then
  sql -Atc "select (select amount from public.subscription_payments where razorpay_payment_id='pay_upgrade_sentinel') = 100" | grep -qx t
fi
sql < scripts/test-launch-integrity.sql
echo "PASS $mode migration and seed rehearsal"

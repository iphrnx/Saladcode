/** Does a fresh signup still get Table 1..N, all Main Hall / 4 seats? */
import { createClient } from '@supabase/supabase-js'

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

const stamp = Date.now().toString(36)
const email = `onb-defaults-${stamp}@example.com`
const password = 'Defaults123!'

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ''}`)
  if (!ok) failures++
}

const user = (await admin.auth.admin.createUser({ email, password, email_confirm: true })).data.user!
const tenant = (await admin.from('tenants').insert({
  name: `Onboarding Defaults ${stamp}`, slug: `onb-defaults-${stamp}`,
  plan: 'starter', active: true, onboarding_done: false,
}).select('id').single()).data!
await admin.from('profiles').insert({ id: user.id, tenant_id: tenant.id, name: 'Defaults Tester', email, role: 'OWNER', active: true })

const { data: sess } = await anon.auth.signInWithPassword({ email, password })
const res = await fetch(`${SB}/functions/v1/onboarding`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${sess!.session!.access_token}`,
    apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  },
  body: JSON.stringify({
    restaurant: { name: `Onboarding Defaults ${stamp}`, currency: 'INR', taxRate: 5 },
    categories: [],
    menuItems: [],
    tables: 5,
  }),
})
const bodyText = await res.text()
check('onboarding accepted the setup', res.ok, `${res.status} ${bodyText.slice(0, 160)}`)

const { data: tables } = await admin.from('tables').select('name, seats, area').eq('tenant_id', tenant.id).order('name')
check('five tables were created', tables?.length === 5, tables?.length)
check('Table 1 exists', !!tables?.some((t) => t.name === 'Table 1'), tables?.map((t) => t.name))
check('every table is Main Hall', tables?.every((t) => t.area === 'Main Hall'), tables)
check('every table has 4 seats', tables?.every((t) => t.seats === 4), tables)
check('no Terrace was invented', !tables?.some((t) => t.area === 'Terrace'))

// cleanup — this tenant was only for the check
await admin.rpc('purge_tenant', { p_tenant_id: tenant.id })
await admin.from('tenants').delete().eq('id', tenant.id)
await admin.auth.admin.deleteUser(user.id)
const { count } = await admin.from('tenants').select('id', { count: 'exact', head: true }).ilike('name', 'Onboarding Defaults%')
check('fixture removed', (count ?? 0) === 0, count)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)

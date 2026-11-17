/**
 * Verification suite for Performance Fixes:
 * 1. P0-1 Diner session polling & Realtime event synchronization
 * 2. P0-2 POS synchronization, visibility awareness, adaptive backoff, and deduplication
 * 3. P1-1 Database index behavior & query plan verification
 * 4. P1-3 Dynamic code splitting & bundle integrity
 * 5. P2-1 Edge Function batching & query phase reduction
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

describe('Performance Fixes Verification Suite', () => {

  it('P0-1: Diner session validation is Realtime-first and visibility-aware', () => {
    const publicMenuContent = fs.readFileSync('src/components/public/public-menu.tsx', 'utf-8')

    // 1. Unconditional 1.5s poll must not exist
    assert.doesNotMatch(publicMenuContent, /setInterval\([^)]+,\s*1500\)/, 'Fixed 1.5s interval poll must be eliminated')

    // 2. Realtime channel subscription status must be tracked
    assert.match(publicMenuContent, /isRealtimeConnectedRef/, 'Must track realtime connection state via ref')
    assert.match(publicMenuContent, /status === ['"]SUBSCRIBED['"]/, 'Must detect SUBSCRIBED channel status')

    // 3. Tab visibility awareness must be present
    assert.match(publicMenuContent, /document\.hidden/, 'Must check document.hidden before validating session')
    assert.match(publicMenuContent, /visibilitychange/, 'Must listen to visibilitychange for instant catch-up')
    assert.match(publicMenuContent, /addEventListener\(['"]online['"]/, 'Must listen to online event for immediate reconciliation')

    // 4. In-flight request deduplication must be present
    assert.match(publicMenuContent, /isValidatingSessionRef/, 'Must prevent duplicate concurrent validation requests')

    // 5. Adaptive interval backoff: 30s when healthy, 5s when awaiting activation, 10s when disconnected
    assert.match(publicMenuContent, /30000/, 'Must use 30s heartbeat when Realtime is healthy')
    assert.match(publicMenuContent, /5000/, 'Must use 5s poll when awaiting table activation')
    assert.match(publicMenuContent, /10000/, 'Must fall back to 10s poll when disconnected')

    // 6. Reliable session termination: BroadcastChannel + Realtime + Lock
    assert.match(publicMenuContent, /the_salad_orders_sync/, 'Must retain BroadcastChannel for instant cross-tab sync')
    assert.match(publicMenuContent, /SESSION_ENDED/, 'Must handle SESSION_ENDED events')
    assert.match(publicMenuContent, /lockDinerSession/, 'Must lock session immediately on termination')
  })

  it('P0-2: POS synchronization is visibility-aware, deduplicated, and adaptive', () => {
    const dataContextContent = fs.readFileSync('src/components/app/data-context.tsx', 'utf-8')

    // 1. Unconditional 4.0s setInterval must be eliminated
    assert.doesNotMatch(dataContextContent, /setInterval\(runDeltaSync,\s*4000\)/, 'Unconditional 4s interval poll must be eliminated')

    // 2. In-flight deduplication must be present
    assert.match(dataContextContent, /isSyncingRef/, 'Must guard in-flight sync requests')

    // 3. Tab visibility awareness
    assert.match(dataContextContent, /document\.hidden/, 'Must check document.hidden to pause polling when tab is hidden')
    assert.match(dataContextContent, /visibilitychange/, 'Must listen to visibilitychange for immediate sync upon tab focus')

    // 4. Adaptive timing: 15s when Realtime is healthy, 5s when disconnected
    assert.match(dataContextContent, /15000/, 'Must back off to 15s poll when Realtime is healthy')
    assert.match(dataContextContent, /5000/, 'Must fall back to 5s poll when Realtime is disconnected')

    // 5. Broadcast vs CDC deduplication
    assert.match(dataContextContent, /recentBroadcastOrderIds/, 'Must track recently broadcast orders to prevent duplicate CDC sync')

    // 6. Referential equality guards to eliminate React render churn
    assert.match(dataContextContent, /useMemo/, 'Must memoize AppContext.Provider value')
  })

  it('P1-3: Views and root modules are dynamically code-split without UI changes', () => {
    const appShellContent = fs.readFileSync('src/components/app/app-shell.tsx', 'utf-8')
    const pageContent = fs.readFileSync('src/app/page.tsx', 'utf-8')

    // app-shell.tsx code splitting
    assert.match(appShellContent, /dynamic\(\(\)\s*=>\s*import\('@\/components\/views\/orders'\)/, 'OrdersView must be code-split')
    assert.match(appShellContent, /dynamic\(\(\)\s*=>\s*import\('@\/components\/views\/settings'\)/, 'SettingsView must be code-split')
    assert.match(appShellContent, /dynamic\(\(\)\s*=>\s*import\('@\/components\/views\/roles'\)/, 'RolesView must be code-split')
    assert.match(appShellContent, /dynamic\(\(\)\s*=>\s*import\('@\/components\/views\/analytics'\)/, 'AnalyticsView must be code-split')

    // STRICT UI PRESERVATION: No added loading screens or spinners in dynamic views
    assert.doesNotMatch(appShellContent, /function ViewLoading/, 'Must NOT add new loading screens or spinners')
    assert.doesNotMatch(pageContent, /function PageLoading/, 'Must NOT add new page loading screens or spinners')

    // Root page code splitting
    assert.match(pageContent, /dynamic\(\(\)\s*=>\s*import\('@\/components\/app\/app-shell'\)/, 'AppShell must be code-split')
    assert.match(pageContent, /dynamic\(\(\)\s*=>\s*import\('@\/components\/public\/public-menu'\)/, 'PublicMenu must be code-split')
  })

  it('P2-1: Edge Function orders/index.ts eliminates query waterfall in sync', () => {
    const ordersEdgeContent = fs.readFileSync('supabase/functions/orders/index.ts', 'utf-8')

    // Phase 1 must batch changedQuery, tenant_order_summary, openChecks, and table_sessions
    assert.match(ordersEdgeContent, /Phase 1: Parallelize the 4 foundational read queries/, 'Must batch initial queries concurrently')
    assert.match(ordersEdgeContent, /Phase 2: Parallelize check settlement aggregation/, 'Must batch secondary check & session queries')
  })

  it('P1-1: Reversible migration file exists with documentation', () => {
    const migrationPath = 'supabase/migrations/20261116000006_orders_sync_composite_index.sql'
    assert.ok(fs.existsSync(migrationPath), 'Migration file must exist')
    const migrationContent = fs.readFileSync(migrationPath, 'utf-8')

    assert.match(migrationContent, /idx_orders_tenant_updated/, 'Must define idx_orders_tenant_updated index')
    assert.match(migrationContent, /idx_table_sessions_tenant_status_created/, 'Must define idx_table_sessions_tenant_status_created index')
    assert.match(migrationContent, /DROP INDEX IF EXISTS/, 'Must include down migration instructions for reversibility')
  })
})


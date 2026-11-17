/**
 * Concurrency & Retry Vulnerabilities (C1–C5) Verification Suite
 *
 * Verifies that all 5 concurrency & retry fixes are implemented and verified:
 * - C1: Order Idempotency Race (unique_violation sub-block & deduplication)
 * - C2: Promo Usage Race (atomic IF NOT FOUND THEN RAISE EXCEPTION 'PROMO_REJECTED')
 * - C3: Table Activation Race (row-locked FOR UPDATE, rejection of ACTIVE sessions, idempotent reply)
 * - C4: Order Status Partial Commit (elimination of independent order_items updates, atomic trigger sync)
 * - C5: Razorpay Webhook Retry Loss (lease-based status model: pending, processing, processed, failed)
 *
 * Usage: npx tsx scripts/test-concurrency-audit.mts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

describe('Concurrency & Retry Vulnerabilities (C1–C5) Verification', () => {

  describe('C1: Order Idempotency Race', () => {
    it('create_order_tx in migration handles unique_violation atomically', () => {
      const mig = fs.readFileSync('supabase/migrations/20261116000007_fix_concurrency_vulnerabilities_c1_c5.sql', 'utf-8')

      // Must have exception block inside insert
      assert.match(mig, /exception\s+when\s+unique_violation\s+then/i,
        'create_order_tx must catch unique_violation on concurrent race')

      // Must fetch existing order using idempotency_key and tenant_id
      assert.match(mig, /select\s+id,\s*order_number,\s*check_id,\s*table_session_id\s+into\s+v_order_id,\s*v_order_num,\s*v_check,\s*v_session\s+from\s+public\.orders\s+where\s+idempotency_key\s*=\s*v_idempotency_key\s+and\s+tenant_id\s*=\s*v_tenant;/i,
        'create_order_tx must return existing order details on idempotency conflict')

      // Must return deduplicated: true
      assert.match(mig, /'deduplicated',\s*true/,
        'create_order_tx must flag deduplicated: true')
    })

    it('orders Edge Function handles idempotency constraint defensively', () => {
      const ordersFn = fs.readFileSync('supabase/functions/orders/index.ts', 'utf-8')
      assert.match(ordersFn, /orders_idempotency_key_idx/,
        'orders/index.ts must catch idempotency index conflicts')
      assert.match(ordersFn, /deduplicated:\s*true/,
        'orders/index.ts must return deduplicated: true on race')
    })
  })

  describe('C2: Promo Usage Race', () => {
    it('create_order_tx enforces strict promo usage limits atomically', () => {
      const mig = fs.readFileSync('supabase/migrations/20261116000007_fix_concurrency_vulnerabilities_c1_c5.sql', 'utf-8')

      // Must update promo_codes with limit condition
      assert.match(mig, /update\s+public\.promo_codes\s+set\s+used_count\s*=\s*used_count\s*\+\s*1/i,
        'create_order_tx must increment used_count')

      // Must verify row was updated (if not found then raise exception)
      assert.match(mig, /if\s+not\s+found\s+then\s+raise\s+exception\s+'PROMO_REJECTED:[^']*'\s+using\s+errcode\s*=\s*'P0001';/i,
        'create_order_tx must abort transaction with PROMO_REJECTED when limit reached')
    })
  })

  describe('C3: Table Activation Race', () => {
    it('refuse_table_activation row locks table_sessions and prevents rejecting active sessions', () => {
      const mig = fs.readFileSync('supabase/migrations/20261116000007_fix_concurrency_vulnerabilities_c1_c5.sql', 'utf-8')

      // Row lock
      assert.match(mig, /select\s+\*\s+into\s+v_session\s+from\s+public\.table_sessions\s+where\s+id\s*=\s*p_session\s+and\s+tenant_id\s*=\s*p_tenant\s+for\s+update;/i,
        'refuse_table_activation must lock table_sessions row with FOR UPDATE')

      // Active guard
      assert.match(mig, /if\s+v_session\.activation_status\s*=\s*'ACTIVE'\s+then\s+raise\s+exception\s+'SESSION_ALREADY_ACTIVE'\s+using\s+errcode\s*=\s*'P0001';/i,
        'refuse_table_activation must reject attempts to refuse an already-active session')

      // Idempotent reply
      assert.match(mig, /if\s+v_session\.activation_status\s*=\s*'REJECTED'\s+or\s+v_session\.status\s*<>\s*'ACTIVE'\s+then\s+return\s+jsonb_build_object\('ok',\s*true,\s*'already',\s*true,\s*'cancelled',\s*0\);/i,
        'refuse_table_activation must return already: true when session is already closed/rejected')
    })
  })

  describe('C4: Order Status Partial Commit', () => {
    it('orders Edge Function eliminates non-atomic order_items updates prior to orders update', () => {
      const ordersFn = fs.readFileSync('supabase/functions/orders/index.ts', 'utf-8')

      // Verify that data.status = target is NOT followed by an uncoordinated order_items update
      const rogueItemUpdate = /data\.status\s*=\s*target;\s*await\s+db\s*\.from\("order_items"\)\s*\.update\(\{ status: target \}\)/.test(ordersFn)
      assert.equal(rogueItemUpdate, false,
        'orders/index.ts must not update order_items before guarded orders update')

      // Database trigger trg_sync_order_items_status handles atomic synchronization
      const baseline = fs.readFileSync('supabase/migrations/20261113000000_baseline_schema.sql', 'utf-8')
      const mig0004 = fs.readFileSync('supabase/migrations/20261116000004_fix_state_machine_discrepancies.sql', 'utf-8')
      assert.match(mig0004, /create\s+or\s+replace\s+function\s+public\.trg_sync_order_items_status/i,
        'Database trigger function trg_sync_order_items_status must exist')
      assert.match(baseline, /create\s+trigger\s+sync_order_items_status/i,
        'Database trigger sync_order_items_status must be installed')
    })
  })

  describe('C5: Razorpay Webhook Retry Loss', () => {
    it('subscription_webhook_events schema supports retry status and leases', () => {
      const mig = fs.readFileSync('supabase/migrations/20261116000007_fix_concurrency_vulnerabilities_c1_c5.sql', 'utf-8')

      assert.match(mig, /add\s+column\s+if\s+not\s+exists\s+status\s+text\s+not\s+null\s+default\s+'processing'/i,
        'Must add status column')
      assert.match(mig, /add\s+column\s+if\s+not\s+exists\s+attempts\s+integer\s+not\s+null\s+default\s+1/i,
        'Must add attempts column')
      assert.match(mig, /check\s*\(status\s+in\s*\('pending',\s*'processing',\s*'processed',\s*'failed'\)\)/i,
        'Must enforce status enum constraint')
    })

    it('apply_subscription_event distinguishes processed, failed, and in_progress events', () => {
      const mig = fs.readFileSync('supabase/migrations/20261116000007_fix_concurrency_vulnerabilities_c1_c5.sql', 'utf-8')

      assert.match(mig, /if\s+v_existing\.status\s*=\s*'processed'\s+then\s+return\s+'duplicate';/i,
        'apply_subscription_event must only return duplicate if status is processed')
      assert.match(mig, /if\s+v_existing\.status\s*=\s*'processing'\s+and\s+v_existing\.received_at\s*>\s*now\(\)\s*-\s*interval\s*'5 minutes'\s+then\s+return\s+'in_progress';/i,
        'apply_subscription_event must return in_progress if active processing lease exists')
      assert.match(mig, /update\s+public\.subscription_webhook_events\s+set\s+status\s*=\s*'processing'/i,
        'apply_subscription_event must claim failed or expired deliveries for retry')
    })

    it('razorpay-webhook Edge Function updates status to processed on success and failed on error', () => {
      const webhookFn = fs.readFileSync('supabase/functions/razorpay-webhook/index.ts', 'utf-8')

      assert.match(webhookFn, /status:\s*"processed"/,
        'razorpay-webhook must mark event as processed upon success')
      assert.match(webhookFn, /status:\s*"failed"/,
        'razorpay-webhook must mark event as failed upon error so Razorpay retries succeed')
      assert.match(webhookFn, /gate\s*===\s*"in_progress"/,
        'razorpay-webhook must handle in_progress deliveries cleanly')
    })
  })
})

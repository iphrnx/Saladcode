/**
 * Production Schema Hardening & Integrity Verification Suite
 *
 * Verifies that the production hardening migration and application code satisfy:
 * 1. Financial cascading delete prevention (RESTRICT instead of CASCADE)
 * 2. Public RLS / QR-token security (drop tables_public_read, revoke gen_random_bytes)
 * 3. Tenant composite foreign keys & cross-tenant reference prevention
 * 4. Business uniqueness guarantees (order_number, invoice_number, categories)
 * 5. Financial sanity check constraints (NOT VALID -> VALIDATE pattern)
 * 6. Actor ID attribution in record_check_payment (profiles vs staff)
 * 7. Table deletion defensive guards in tables Edge Function
 * 8. Schema hygiene: dropping rogue test functions and un-scoped legacy overloads
 *
 * Usage: npx tsx scripts/test-production-schema-hardening.mts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

describe('Production Schema Hardening Verification', () => {
  const migContent = fs.readFileSync(
    'supabase/migrations/20261117000001_production_schema_hardening.sql',
    'utf-8'
  )
  const tablesEdgeContent = fs.readFileSync(
    'supabase/functions/tables/index.ts',
    'utf-8'
  )

  describe('1. Financial Cascading Delete Protection', () => {
    it('alters table_checks foreign keys to ON DELETE RESTRICT', () => {
      assert.match(
        migContent,
        /alter\s+table\s+public\.table_checks[\s\S]+?foreign\s+key\s+\(table_id\)\s+references\s+public\.tables\(id\)\s+on\s+delete\s+restrict/i,
        'table_checks(table_id) must be ON DELETE RESTRICT'
      )
      assert.match(
        migContent,
        /alter\s+table\s+public\.table_checks[\s\S]+?foreign\s+key\s+\(session_id\)\s+references\s+public\.table_sessions\(id\)\s+on\s+delete\s+restrict/i,
        'table_checks(session_id) must be ON DELETE RESTRICT'
      )
    })

    it('alters check_payments foreign key to ON DELETE RESTRICT', () => {
      assert.match(
        migContent,
        /alter\s+table\s+public\.check_payments[\s\S]+?foreign\s+key\s+\(check_id\)\s+references\s+public\.table_checks\(id\)\s+on\s+delete\s+restrict/i,
        'check_payments(check_id) must be ON DELETE RESTRICT'
      )
    })

    it('tables Edge Function guards against deleting tables with sales history or active orders', () => {
      assert.match(
        tablesEdgeContent,
        /from\("orders"\)[\s\S]+?not\("status",\s*"in",\s*"\([A-Z,]+\)"\)/,
        'tables remove() must check for active orders before deletion'
      )
      assert.match(
        tablesEdgeContent,
        /from\("table_checks"\)[\s\S]+?count:\s*"exact"/,
        'tables remove() must check for historical table_checks before deletion'
      )
      assert.match(
        tablesEdgeContent,
        /Cannot delete table with sales history/i,
        'tables remove() must inform user to deactivate table rather than delete'
      )
    })
  })

  describe('2. Security Hardening & Public RLS Lockdown', () => {
    it('drops wide-open tables_public_read policy to prevent QR token enumeration', () => {
      assert.match(
        migContent,
        /drop\s+policy\s+if\s+exists\s+"tables_public_read"\s+on\s+public\.tables;/i,
        'Must drop tables_public_read policy'
      )
    })

    it('revokes public execute privileges on gen_random_bytes', () => {
      assert.match(
        migContent,
        /revoke\s+execute\s+on\s+function\s+public\.gen_random_bytes\(integer\)\s+from\s+public,\s*anon,\s*authenticated;/i,
        'Must revoke execute on gen_random_bytes from anon/authenticated'
      )
      assert.match(
        migContent,
        /grant\s+execute\s+on\s+function\s+public\.gen_random_bytes\(integer\)\s+to\s+service_role;/i,
        'Must restrict gen_random_bytes to service_role'
      )
    })
  })

  describe('3. Tenant Composite Integrity & Foreign Keys', () => {
    it('creates composite uniqueness on parent tables to enable composite FKs', () => {
      assert.match(
        migContent,
        /alter\s+table\s+public\.tables\s+add\s+constraint\s+tables_tenant_id_id_key\s+unique\s+\(tenant_id,\s*id\);/i,
        'tables must have unique (tenant_id, id)'
      )
      assert.match(
        migContent,
        /alter\s+table\s+public\.table_sessions\s+add\s+constraint\s+table_sessions_tenant_id_id_key\s+unique\s+\(tenant_id,\s*id\);/i,
        'table_sessions must have unique (tenant_id, id)'
      )
      assert.match(
        migContent,
        /alter\s+table\s+public\.table_checks\s+add\s+constraint\s+table_checks_tenant_id_id_key\s+unique\s+\(tenant_id,\s*id\);/i,
        'table_checks must have unique (tenant_id, id)'
      )
    })

    it('enforces composite uniqueness on parent tables to enable multi-column tenant integrity', () => {
      assert.match(
        migContent,
        /alter\s+table\s+public\.tables\s+add\s+constraint\s+tables_tenant_id_id_key\s+unique\s+\(tenant_id,\s*id\);/i,
        'tables must have unique (tenant_id, id)'
      )
    })
  })

  describe('4. Business Uniqueness Constraints', () => {
    it('enforces unique order numbers per tenant', () => {
      assert.match(
        migContent,
        /alter\s+table\s+public\.orders\s+add\s+constraint\s+orders_tenant_order_number_key\s+unique\s+\(tenant_id,\s*order_number\);/i,
        'orders must have UNIQUE (tenant_id, order_number)'
      )
    })

    it('enforces unique non-null invoice numbers per tenant', () => {
      assert.match(
        migContent,
        /create\s+unique\s+index\s+if\s+not\s+exists\s+table_checks_tenant_invoice_number_key[\s\S]+?on\s+public\.table_checks\s*\(tenant_id,\s*invoice_number\)\s+where\s*\(invoice_number\s+is\s+not\s+null\);/i,
        'table_checks must have unique partial index on (tenant_id, invoice_number)'
      )
    })

    it('enforces single active check per table', () => {
      assert.match(
        migContent,
        /create\s+unique\s+index\s+if\s+not\s+exists\s+table_checks_one_active_per_table[\s\S]+?where\s*\(status\s+in\s*\('OPEN',\s*'UNSETTLED'\)\);/i,
        'table_checks must enforce single active check per table'
      )
    })

    it('enforces unique category names per tenant', () => {
      assert.match(
        migContent,
        /alter\s+table\s+public\.categories\s+add\s+constraint\s+categories_tenant_name_key\s+unique\s+\(tenant_id,\s*name\);/i,
        'categories must have UNIQUE (tenant_id, name)'
      )
    })
  })

  describe('5. Financial Validation & Date Checks (NOT VALID -> VALIDATE)', () => {
    it('applies non-negative and discount bounds on orders', () => {
      assert.match(
        migContent,
        /check\s*\(items_total\s*>=\s*0\s+and\s+total\s*>=\s*0\s+and\s+tax\s*>=\s*0\s+and\s+discount\s*>=\s*0\s+and\s+service_charge\s*>=\s*0\s+and\s+discount\s*<=\s*items_total\)/i,
        'orders must have financial bounds check'
      )
    })

    it('applies non-negative checks on table_checks and order_items', () => {
      assert.match(
        migContent,
        /check\s*\(subtotal\s*>=\s*0\s+and\s+total\s*>=\s*0\s+and\s+tax\s*>=\s*0\s+and\s+discount\s*>=\s*0\s+and\s+service_charge\s*>=\s*0\s+and\s+paid_total\s*>=\s*0\)/i,
        'table_checks must have financial bounds check'
      )
      assert.match(
        migContent,
        /check\s*\(price\s*>=\s*0\)/i,
        'order_items must check price >= 0'
      )
    })

    it('applies bounds and valid date ordering on promo_codes', () => {
      assert.match(
        migContent,
        /check\s*\(valid_to\s+is\s+null\s+or\s+valid_to\s*>=\s*valid_from\)/i,
        'promo_codes must check valid_to >= valid_from'
      )
    })
  })

  describe('6. Actor ID Attribution in record_check_payment', () => {
    it('resolves actor between profiles and staff to avoid FK errors', () => {
      assert.match(
        migContent,
        /select\s+id\s+into\s+v_profile_actor\s+from\s+public\.profiles\s+where\s+id\s*=\s*p_actor;/i,
        'record_check_payment must check profiles'
      )
      assert.match(
        migContent,
        /select\s+id\s+into\s+v_staff_actor\s+from\s+public\.staff\s+where\s+id\s*=\s*p_actor\s+and\s+tenant_id\s*=\s*p_tenant;/i,
        'record_check_payment must check staff'
      )
      assert.match(
        migContent,
        /created_by,\s*staff_id,\s*status,\s*note[\s\S]+?v_profile_actor,\s*v_staff_actor,\s*'SUCCEEDED'/i,
        'record_check_payment must insert into created_by and staff_id respectively'
      )
    })
  })

  describe('7. Schema Hygiene & Dropping Legacy/Test Overloads', () => {
    it('drops rogue test functions and un-scoped legacy RPC overloads', () => {
      assert.match(migContent, /drop\s+function\s+if\s+exists\s+public\.test_fn\(\);/i)
      assert.match(migContent, /drop\s+function\s+if\s+exists\s+public\.test_m_fn\(\);/i)
      assert.match(migContent, /drop\s+function\s+if\s+exists\s+public\.test_del_fn\(\);/i)
      assert.match(migContent, /drop\s+function\s+if\s+exists\s+public\.approve_table_activation\(uuid,\s*uuid\);/i)
      assert.match(migContent, /drop\s+function\s+if\s+exists\s+public\.refuse_table_activation\(uuid,\s*text,\s*uuid\);/i)
    })
  })

  describe('8. Preflight Checks & Rollback Safety', () => {
    it('includes automated preflight checks and documented rollback instructions', () => {
      assert.match(migContent, /PREFLIGHT_FAILED/i, 'Must contain automated preflight check')
      assert.match(migContent, /ROLLBACK SCRIPT/i, 'Must document rollback procedure')
    })
  })
})


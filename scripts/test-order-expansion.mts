import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  reconcileOrderExpansion as reconcile,
  toggleOrderExpansion as toggle,
} from '../src/components/views/order-expansion'

const first = { id: 'first', status: 'PREPARING' }
const second = { id: 'second', status: 'PENDING' }
const third = { id: 'third', status: 'PENDING' }

test('empty and cancelled tickets do not block the sole valid ticket from opening', () => {
  assert.equal(reconcile(null, []).openId, null)
  assert.equal(reconcile(null, [first]).openId, first.id)
  assert.equal(reconcile(null, [first, { ...second, status: 'CANCELLED' }]).openId, first.id)
})

test('a manual single-order collapse survives refreshes and a return to one order', () => {
  const closed = toggle(reconcile(null, [first]), first.id)
  assert.strictEqual(reconcile(closed, [{ ...first, status: 'READY' }]), closed)
  const multiple = reconcile(closed, [first, second])
  assert.equal(reconcile(multiple, [first]).openId, null)
})

test('a second arrival collapses the sole order, and further arrivals preserve manual state', () => {
  const multiple = reconcile(reconcile(null, [first]), [first, second])
  assert.equal(multiple.openId, null)
  assert.equal(reconcile(multiple, [first, second, third]).openId, null)
  assert.equal(reconcile(null, [first, second, third]).openId, null)
  const openedSecond = toggle(multiple, second.id)
  assert.strictEqual(reconcile(openedSecond, [third, { ...second, status: 'READY' }, first]), openedSecond)
  const openedFirst = toggle(openedSecond, first.id)
  assert.equal(openedFirst.openId, first.id)
  assert.equal(toggle(openedFirst, first.id).openId, null)
})

test('removing orders restores the single-order default and sessions have separate state', () => {
  const opened = toggle(reconcile(null, [first, second, third]), second.id)
  assert.equal(reconcile(opened, [first, third]).openId, null)
  assert.equal(reconcile(opened, [third]).openId, third.id)
  assert.equal(reconcile(null, [first, second]).openId, null)
})

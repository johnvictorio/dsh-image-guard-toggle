import test from 'node:test'
import assert from 'node:assert/strict'
import { planMirrorOperation } from './index.js'

const llm = (v) => ({ providers: { hyper: v === undefined ? {} : { maxRequestImageBytes: v } } })

test('on with default budget sets 8MB when unset', () => {
  assert.deepEqual(planMirrorOperation(llm(), { enabled: true, budgetMb: 8, route: 'hyper' }), {
    kind: 'op',
    op: { op: 'set', path: ['providers', 'hyper', 'maxRequestImageBytes'], value: 8388608 },
  })
})

test('on is noop when value already matches', () => {
  assert.deepEqual(planMirrorOperation(llm(8388608), { enabled: true, budgetMb: 8, route: 'hyper' }), { kind: 'noop' })
})

test('on rewrites when budget differs', () => {
  const plan = planMirrorOperation(llm(8388608), { enabled: true, budgetMb: 5, route: 'hyper' })
  assert.equal(plan.kind, 'op')
  assert.equal(plan.op.op, 'set')
  assert.equal(plan.op.value, 5242880)
})

test('off unsets when an override exists', () => {
  assert.deepEqual(planMirrorOperation(llm(8388608), { enabled: false, budgetMb: 8, route: 'hyper' }), {
    kind: 'op',
    op: { op: 'unset', path: ['providers', 'hyper', 'maxRequestImageBytes'] },
  })
})

test('off is noop when nothing is overridden', () => {
  assert.deepEqual(planMirrorOperation(llm(), { enabled: false, budgetMb: 8, route: 'hyper' }), { kind: 'noop' })
})

test('missing route reports instead of writing', () => {
  assert.deepEqual(planMirrorOperation(llm(100), { enabled: true, budgetMb: 8, route: 'ghost' }), {
    kind: 'missing-route',
    route: 'ghost',
    want: 8388608,
  })
  assert.deepEqual(planMirrorOperation(undefined, { enabled: true, budgetMb: 8, route: 'hyper' }).kind, 'missing-route')
})

test('missing route with off stays inert', () => {
  assert.equal(planMirrorOperation(llm(100), { enabled: false, budgetMb: 8, route: 'ghost' }).kind, 'missing-route')
})

test('default route and budget fill in', () => {
  const plan = planMirrorOperation(llm(), { enabled: true })
  assert.deepEqual(plan.op.path, ['providers', 'hyper', 'maxRequestImageBytes'])
  assert.equal(plan.op.value, 8388608)
  const bad = planMirrorOperation(llm(), { enabled: true, budgetMb: NaN })
  assert.equal(bad.op.value, 8388608)
})

test('empty route string falls back to default', () => {
  const plan = planMirrorOperation(llm(), { enabled: true, route: '' })
  assert.deepEqual(plan.op.path, ['providers', 'hyper', 'maxRequestImageBytes'])
})

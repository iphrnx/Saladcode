/**
 * Public-menu bill refs: exercise the real hook fragment without rendering the
 * full app, opening a browser, or calling Supabase. This is a focused render /
 * commit model, not a browser or React integration test.
 *
 * Run: npx tsx scripts/test-public-menu-refs-offline.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const text = readFileSync(new URL('../src/components/public/public-menu.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('public-menu.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'PublicMenu',
)
assert.ok(component?.body, 'PublicMenu must exist')
const statements = component.body.statements
const firstRef = statements.find((node) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(
    (decl) => ts.isIdentifier(decl.name) && decl.name.text === 'billOrderIdRef',
  ),
)
const syncEffect = statements.find((node) =>
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'useEffect' &&
  node.getText(source).includes('billOrderIdRef.current = billOrderId') &&
  node.getText(source).includes('billOpenRef.current = billOpen'),
)
assert.ok(firstRef && syncEffect, 'both refs must be synchronized inside an effect')

// Include every statement between the first ref and the effect. Reintroducing
// either render-time assignment makes the assertions below fail.
const fragment = text.slice(firstRef.getStart(source), syncEffect.end)
const compiled = ts.transpileModule(fragment, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText
const runFragment = new Function('billOrderId', 'billOpen', 'useRef', 'useEffect',
  `${compiled}\nreturn [billOrderIdRef, billOpenRef];`,
) as (id: string | null, open: boolean, useRef: unknown, useEffect: unknown) => Array<{ current: unknown }>

const refs: Array<{ current: unknown }> = []
function render(id: string | null, open: boolean) {
  let cursor = 0
  const effects: Array<() => void> = []
  let dependencies: unknown[] = []
  const result = runFragment(id, open,
    (initial: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current: initial }),
    (effect: () => void, deps: unknown[]) => { effects.push(effect); dependencies = deps },
  )
  assert.deepEqual(dependencies, [id, open], 'both state values must be effect dependencies')
  return { result, commit: () => effects.forEach((effect) => effect()) }
}
function values() { return refs.map((ref) => ref.current) }

const initial = render(null, false)
assert.deepEqual(values(), [null, false])
initial.commit()
const opening = render('order-a', true)
assert.deepEqual(values(), [null, false], 'an uncommitted open must not leak to the realtime listener')
opening.commit()
assert.deepEqual(values(), ['order-a', true], 'committed opening synchronizes both refs')

render('abandoned-order', false) // Simulate an abandoned speculative render.
assert.deepEqual(values(), ['order-a', true], 'abandoned renders cannot change the listener state')
const closing = render('order-a', false)
closing.commit()
assert.deepEqual(values(), ['order-a', false], 'committed closure suppresses bill refreshes')
const switching = render('order-b', true)
switching.commit()
assert.deepEqual(values(), ['order-b', true], 'reopening a different bill replaces the tracked order')

console.log('Public-menu bill refs: render purity, abandoned render, open/close/order switch, and dependencies passed (offline).')

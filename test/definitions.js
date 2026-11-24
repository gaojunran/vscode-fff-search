// Guards the definition classifier we depend on. It runs the real engine against
// a fixture instead of a stub, because the rules live upstream: a pin bump that
// stops classifying these forms has to fail here rather than silently drop the
// markers in the picker.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')
const { FileFinder } = require('@ff-labs/fff-node')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fff-definitions-'))
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }))

fs.writeFileSync(
  path.join(ROOT, 'sample.ts'),
  [
    'export const inlineArrow = async (a: string) => { return a }',
    'export const multiLineArrow = async (',
    '  a: string,',
    '  b: number,',
    ') => { return a }',
    'export const plainMultiLine = (',
    '  a: string,',
    ') => { return a }',
    'export function declared(',
    '  a: string,',
    ') { return a }',
    "export const callInitializer = defineStore('callInitializer', () => {})",
    'import { inlineArrow } from "./other"',
  ].join('\n'),
)

const query = finder => (name, line) => {
  const result = finder.grep(name, {
    mode: 'plain',
    pageSize: 50,
    smartCase: true,
    classifyDefinitions: 'classify',
  })
  assert.ok(result.ok, `grep failed: ${result.error}`)
  const hit = result.value.items.find(match => match.lineNumber === line)
  assert.ok(hit, `line ${line} should be a hit for ${name}`)
  return Boolean(hit.isDefinition)
}

;(async () => {
  const created = FileFinder.create({ basePath: ROOT, disableWatch: true })
  assert.ok(created.ok, `index build failed: ${created.error}`)
  const finder = created.value
  await finder.waitForScan(20000)
  await finder.waitForIndexReady(30000)
  const isDefinition = query(finder)

  const cases = [
    ['inlineArrow', 1, true, 'an arrow export on one line'],
    // Fixed upstream in #1017 (fff 0.11.1-nightly.eb58401); a parameter list that
    // closes on a later line still declares the same binding.
    ['multiLineArrow', 2, true, 'a parameter list spanning lines'],
    ['plainMultiLine', 6, true, 'a multi-line list without async'],
    ['declared', 9, true, 'a declared function with multi-line parameters'],
    // Upstream treats a call initializer as not-a-definition on purpose: widening
    // it would mark every `const x = foo()` as a definition.
    ['callInitializer', 12, false, 'a call initializer'],
    ['inlineArrow', 13, false, 'an import line'],
  ]

  let failures = 0
  for (const [name, line, expected, label] of cases) {
    const actual = isDefinition(name, line)
    const ok = actual === expected
    if (!ok) failures++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: expected ${expected}, got ${actual}`)
  }

  finder.destroy()
  process.exitCode = failures ? 1 : 0
})()

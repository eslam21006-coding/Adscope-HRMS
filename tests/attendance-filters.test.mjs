import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const loaderPath = new URL('../admin/index.html', import.meta.url)
const source = readFileSync(loaderPath, 'utf8')

function filterScript() {
  const match = source.match(/const source=`([\s\S]*?)`;\n\s*return '<scr'/)
  assert.ok(match, 'Attendance filter source must remain extractable from the Admin loader')
  return match[1]
}

test('Admin loader injects attendance filters only into the real Admin bundle', () => {
  assert.ok(source.includes('data-adscope-attendance-filters="date-person-v1"'))
  assert.ok(source.includes("const shouldInjectFilters=/id\\s*=\\s*[\"']app[\"']/i.test(html);"))
  assert.ok(source.includes("const filterPatch=shouldInjectFilters?attendanceFilterPatch():'';"))
  assert.ok(source.includes("html.replace(/<\\/body>/i,filterPatch+'</body>')"))
})

test('Attendance filters provide exact date, employee and attended-only controls', () => {
  const script = filterScript()
  assert.match(script, /data-attendance-date/)
  assert.match(script, /data-attendance-employee/)
  assert.match(script, /All employees/)
  assert.match(script, /All attendance records/)
  assert.match(script, /Attended only/)
  assert.match(script, /details\.date===filterState\.date/)
  assert.match(script, /employeeKey===filterState\.employee/)
  assert.match(script, /filterState\.mode!==['"]attended['"]\|\|details\.attended/)
  assert.match(script, /row\.hidden=!show/)
})

test('Attendance filters stay inside the selected month and can be cleared', () => {
  const script = filterScript()
  assert.match(script, /dateInput\.min=bounds\.min/)
  assert.match(script, /dateInput\.max=bounds\.max/)
  assert.match(script, /data-attendance-reset/)
  assert.match(script, /filterState=\{date:'',employee:'',mode:'all'\}/)
  assert.match(script, /target\.id===['"]activeMonth['"]/)
})

test('Attendance filtering is read-only and the injected script parses', () => {
  const script = filterScript()
  assert.doesNotMatch(script, /\.from\(|\.rpc\(|\.update\(|\.insert\(|\.delete\(/)
  assert.doesNotThrow(() => new vm.Script(script))
})

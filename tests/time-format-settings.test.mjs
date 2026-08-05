import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const adminSource = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8')
const employeeSource = readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8')

function patchScript(source, functionName) {
  const pattern = new RegExp(`function ${functionName}\\([^)]*\\)\\s*\\{\\s*const source=\`([\\s\\S]*?)\`;\\s*return`)
  const match = source.match(pattern)
  assert.ok(match, `${functionName} source must remain extractable`)
  return match[1]
}

test('Admin settings hide CODE columns without removing internal code data', () => {
  const script = patchScript(adminSource, 'displaySettingsPatch')
  assert.match(script, /textContent\.trim\(\)\.toLowerCase\(\)!==['"]code['"]/)
  assert.match(script, /row\.cells\[index\]\.hidden=true/)
})

test('Owners can save the organization-wide 12 or 24 hour setting', () => {
  const script = patchScript(adminSource, 'displaySettingsPatch')
  assert.match(script, /data-adscope-time-format-settings/)
  assert.match(script, /12-hour \(9:30 AM\)/)
  assert.match(script, /24-hour \(09:30\)/)
  assert.match(script, /state\.role!==['"]owner['"]/)
  assert.match(script, /\.from\(['"]organizations['"]\)\.update\(\{time_format:value/)
  assert.match(script, /\.select\(['"]timezone,time_format['"]\)/)
})

test('Admin and employee loaders apply the saved time format to rendered times', () => {
  const adminScript = patchScript(adminSource, 'displaySettingsPatch')
  const employeeScript = patchScript(employeeSource, 'employeeTimeFormatPatch')
  for (const script of [adminScript, employeeScript]) {
    assert.match(script, /state\.timeFormat===['"]24['"]/)
    assert.match(script, /AM/)
    assert.match(script, /PM/)
    assert.match(script, /MutationObserver/)
    assert.match(script, /characterData:true/)
    assert.doesNotThrow(() => new vm.Script(script))
  }
})

test('Time formatting is injected only into the intended portal bundle', () => {
  assert.ok(adminSource.includes('data-adscope-display-settings="time-format-v1"'))
  assert.ok(adminSource.includes('const displayPatch=shouldInjectFilters?displaySettingsPatch():\'\';'))
  assert.ok(employeeSource.includes('data-adscope-employee-time-format="time-format-v1"'))
  assert.ok(employeeSource.includes('const shouldInjectTimeFormat=/id\\s*=\\s*["\']portalApp["\']/i.test(html);'))
})

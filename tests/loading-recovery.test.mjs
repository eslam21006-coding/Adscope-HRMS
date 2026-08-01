import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const projectRoot = new URL('../', import.meta.url)
const adminLoaderPath = new URL('../admin/index.html', import.meta.url)
const employeeLoaderPath = new URL('../attendance/index.html', import.meta.url)
const staticFunctionPath = new URL('../supabase/functions/hrms-static-assets/index.ts', import.meta.url)
const adminSourcePath = new URL('../admin/app.js', import.meta.url)
const employeeSourcePath = new URL('../attendance/portal.js', import.meta.url)
const adminFixturePath = new URL('./fixtures/admin-bundle.html', import.meta.url)
const employeeFixturePath = new URL('./fixtures/attendance-bundle.html', import.meta.url)

function inlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i)
  assert.ok(match, 'Expected one inline loader script')
  return match[1]
}

function documentHarness() {
  const state = { bodyHtml:'', written:'', retry:null }
  const retry = {
    addEventListener(event, callback) {
      if (event === 'click') state.retry = callback
    },
  }
  const body = {}
  Object.defineProperty(body, 'innerHTML', {
    get: () => state.bodyHtml,
    set: value => { state.bodyHtml = String(value) },
  })
  const document = {
    body,
    getElementById(id) { return id === 'retryPortal' ? retry : null },
    open() { state.written = '' },
    write(value) { state.written += String(value) },
    close() {},
  }
  return { document, state }
}

async function executeLoader(file, fetchImpl, timeoutMs = 10, settleMs = 40, { decompressionSupported = true } = {}) {
  const html = readFileSync(file, 'utf8')
  const script = inlineScript(html)
    .replace('const timeoutMs = 15000;', `const timeoutMs = ${timeoutMs};`)
  const { document, state } = documentHarness()
  const window = { setTimeout, clearTimeout }
  if (decompressionSupported) window.DecompressionStream = DecompressionStream
  const context = {
    AbortController,
    Blob,
    DecompressionStream,
    Promise,
    Response,
    Uint8Array,
    atob,
    clearTimeout,
    console,
    document,
    fetch: fetchImpl,
    setTimeout,
    window,
  }
  vm.runInNewContext(script, context)
  await new Promise(resolve => setTimeout(resolve, settleMs))
  return state
}

for (const [name, file] of [['Admin', adminLoaderPath], ['Employee', employeeLoaderPath]]) {
  test(`${name} loader downloads and injects a valid gzip bundle`, async () => {
    const expected = '<!doctype html><title>Loaded</title>'
    const encoded = gzipSync(expected).toString('base64')
    const state = await executeLoader(file, async () => ({ ok:true, text:async () => encoded }), 500, 100)
    assert.equal(state.written, expected)
    assert.equal(state.bodyHtml.includes('Unable to open the portal'), false)
  })

  test(`${name} loader times out with a readable Retry action`, async () => {
    const state = await executeLoader(file, () => new Promise(() => {}))
    assert.match(state.bodyHtml, /Unable to open the portal/)
    assert.match(state.bodyHtml, /Check your connection and try again/)
    assert.equal(typeof state.retry, 'function')
    assert.doesNotMatch(state.bodyHtml, /SQL|stack|payload|constraint|service.role/i)
  })

  for (const [failure, fetchImpl, options] of [
    ['an unsuccessful bundle response', async () => ({ ok:false, text:async () => '' }), {}],
    ['a malformed bundle response', async () => ({ ok:true, text:async () => 'not-valid-base64!' }), {}],
    ['a browser without gzip decompression support', async () => ({ ok:true, text:async () => '' }), { decompressionSupported:false }],
  ]) {
    test(`${name} loader recovers from ${failure}`, async () => {
      const state = await executeLoader(file, fetchImpl, 500, 40, options)
      assert.match(state.bodyHtml, /Unable to open the portal/)
      assert.equal(typeof state.retry, 'function')
      assert.equal(state.written, '')
    })
  }
}

function recoveryScript() {
  const source = readFileSync(staticFunctionPath, 'utf8')
  const match = source.match(/const INITIALIZATION_RECOVERY_PATCH = String\.raw`([\s\S]*?)`\n\nconst UX_PATCH/)
  assert.ok(match, 'Initialization recovery patch must be present')
  return match[1]
    .replace(/^<script[^>]*>/, '')
    .replace(/<\/script>$/, '')
    .replace('var timeoutMs=15000;', 'var timeoutMs=10;')
}

function recoveryContext({ stable = false } = {}) {
  const state = { callback:null, html:'', retry:null, reloads:0, stable, observed:false, disconnected:false, domReady:null }
  const retry = { addEventListener(event, callback) { if (event === 'click') state.retry = callback } }
  const root = {
    querySelector(selector) {
      if (selector === '[data-init-retry]') return retry
      if (selector === '.login-page,.shell,.page') return state.stable ? {} : null
      return null
    },
  }
  Object.defineProperty(root, 'innerHTML', {
    get: () => state.html,
    set: value => { state.html = String(value) },
  })
  const auth = {
    onAuthStateChange(callback) {
      state.callback = callback
      return { data:{ subscription:{ unsubscribe(){} } } }
    },
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback }
    observe() { state.observed = true }
    disconnect() { state.disconnected = true }
  }
  const window = { clearTimeout, setTimeout, supabase: { createClient: () => ({ auth }) } }
  const document = {
    getElementById(id) { return ['app','portalApp'].includes(id) ? root : null },
    addEventListener(event, callback) { if (event === 'DOMContentLoaded') state.domReady = callback },
  }
  const location = { reload() { state.reloads += 1 } }
  return { context:{ console, document, location, MutationObserver, Object, Promise, setTimeout, window }, state, window }
}

test('Auth callback releases the Supabase lock before application queries run', async () => {
  const { context, state, window } = recoveryContext()
  vm.runInNewContext(recoveryScript(), context)
  const client = window.supabase.createClient()
  let lockHeld = true
  let callbackSawLock = null
  client.auth.onAuthStateChange(async () => { callbackSawLock = lockHeld })
  const returned = state.callback('INITIAL_SESSION', { user:{ id:'owner' } })
  assert.equal(returned, undefined)
  lockHeld = false
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(callbackSawLock, false)
})

test('Tracked source callbacks also defer work until after the Supabase auth lock is released', () => {
  for (const path of [adminSourcePath, employeeSourcePath]) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /onAuthStateChange\s*\(\s*async\b/)
    assert.match(source, /onAuthStateChange\([\s\S]*?setTimeout\(/)
  }
})

test('Application initialization watchdog replaces a spinner with Retry', async () => {
  const { context, state } = recoveryContext()
  vm.runInNewContext(recoveryScript(), context)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.match(state.html, /Unable to open the portal/)
  assert.match(state.html, /data-init-retry/)
  assert.equal(typeof state.retry, 'function')
  state.retry()
  assert.equal(state.reloads, 1)
})

test('Application initialization watchdog stops after a stable application view renders', async () => {
  const { context, state } = recoveryContext({ stable:true })
  vm.runInNewContext(recoveryScript(), context)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(state.observed, true)
  assert.equal(state.disconnected, true)
  assert.equal(state.html, '')
})

test('Recovery patch does not install a global unhandled-rejection UI override', () => {
  assert.doesNotMatch(recoveryScript(), /unhandledrejection/)
})

test('Checked-in bundle shapes accept recovery injection and portal URL replacement', () => {
  const fixturePaths = [adminFixturePath, employeeFixturePath]
  const scriptAnchor = /(<script\s+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"']+["']><\/script>)/i
  for (const path of fixturePaths) {
    const current = readFileSync(path, 'utf8')
    assert.match(current, scriptAnchor)
    const migrated = current
      .replaceAll('https://attendance.adscope.net/', 'https://portal.adscope.net/')
      .replaceAll('https://attendance.adscope.net', 'https://portal.adscope.net')
    assert.doesNotMatch(migrated, /https:\/\/attendance\.adscope\.net/)
  }
})

test('Vercel routing keeps employee access available during the portal-domain transition', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.equal(config.rewrites[0].source, '/')
  assert.equal(config.rewrites[0].destination, '/attendance/')
  assert.equal(config.rewrites[0].has[0].type, 'host')
  assert.equal(config.rewrites[0].has[0].key, undefined)
  assert.equal(config.rewrites[0].has[0].value, 'attendance\\.adscope\\.net')
  assert.equal(config.rewrites[1].source, '/')
  assert.equal(config.rewrites[1].destination, '/attendance/')
  assert.equal(config.rewrites[1].has[0].type, 'host')
  assert.equal(config.rewrites[1].has[0].key, undefined)
  assert.equal(config.rewrites[1].has[0].value, 'portal\\.adscope\\.net')
  assert.ok(!(config.redirects ?? []).some(({ has }) =>
    has?.some(({ type, value }) => type === 'host' && value === 'attendance\\.adscope\\.net')
  ))
  const rootLoader = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(rootLoader, /host === 'attendance\.adscope\.net'\) location\.replace\('\/attendance\//)
  assert.doesNotMatch(rootLoader, /host === 'attendance\.adscope\.net'[\s\S]*?location\.replace\('https:\/\/portal\.adscope\.net/)
  assert.equal(config.headers[0].headers.find(header => header.key === 'Strict-Transport-Security').value, 'max-age=31536000')
})

test('Browser-delivered files do not contain a private Supabase key', () => {
  const browserFiles = ['index.html', 'config.js', 'admin/index.html', 'admin/app.js', 'attendance/index.html', 'attendance/portal.js']
  for (const relative of browserFiles) {
    const source = readFileSync(new URL(relative, projectRoot), 'utf8')
    assert.doesNotMatch(source, /service[_-]?role|sb_secret_|SUPABASE_SECRET/i)
  }
})

test('Static bundle failures return a safe public message', () => {
  const source = readFileSync(staticFunctionPath, 'utf8')
  assert.match(source, /\{ error: 'Unable to load the HRMS portal' \}/)
  assert.doesNotMatch(source, /\{ error: error instanceof Error/)
})

test('Owner-only Edge Functions use explicit origin allowlists', () => {
  for (const relative of ['supabase/functions/admin-user-access/index.ts', 'supabase/functions/disciplinary-email/index.ts']) {
    const source = readFileSync(new URL(relative, projectRoot), 'utf8')
    assert.doesNotMatch(source, /endsWith\(['"]\.vercel\.app['"]\)/)
    assert.match(source, /EXTRA_ORIGINS|EXTRA_ALLOWED_ORIGINS/)
  }
})

test('Administrative account deletion is tenant-scoped and fails closed on history errors', () => {
  const source = readFileSync(new URL('../supabase/functions/admin-user-access/index.ts', import.meta.url), 'utf8')
  assert.match(source, /This login does not belong to your organization/)
  assert.match(source, /checks\.some\(r=>r\.error\)/)
  assert.match(source, /deleteMembershipError/)
  assert.match(source, /another organization/)
})

test('Disciplinary email delivery is organization-scoped, bounded, and idempotent', () => {
  const source = readFileSync(new URL('../supabase/functions/disciplinary-email/index.ts', import.meta.url), 'utf8')
  assert.match(source, /eq\('organization_id',violation\.organization_id\)/)
  assert.match(source, /AbortSignal\.timeout\(10_000\)/)
  assert.match(source, /'Idempotency-Key'/)
  assert.match(source, /delivery_unknown/)
  assert.match(source, /if\(finalization\.error\)/)
})

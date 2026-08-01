import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const projectRoot = new URL('../', import.meta.url)
const adminLoaderPath = new URL('../admin/index.html', import.meta.url)
const employeeLoaderPath = new URL('../attendance/index.html', import.meta.url)
const staticFunctionPath = new URL('../supabase/functions/hrms-static-assets/index.ts', import.meta.url)
const adminSourcePath = new URL('../admin/app.js', import.meta.url)
const employeeSourcePath = new URL('../attendance/portal.js', import.meta.url)

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

async function executeLoader(file, fetchImpl, timeoutMs = 10, settleMs = 40) {
  const html = readFileSync(file, 'utf8')
  const script = inlineScript(html)
    .replace('const timeoutMs = 15000;', `const timeoutMs = ${timeoutMs};`)
  const { document, state } = documentHarness()
  const window = { DecompressionStream, setTimeout, clearTimeout }
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

function recoveryContext({ pending = false } = {}) {
  const state = { callback:null, html:'', retry:null, reloads:0, unhandled:null }
  const retry = { addEventListener(event, callback) { if (event === 'click') state.retry = callback } }
  const root = {
    querySelector(selector) { return selector === '[data-init-retry]' ? retry : null },
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
  const window = {
    addEventListener(event, callback) { if (event === 'unhandledrejection') state.unhandled = callback },
    clearTimeout,
    setTimeout,
    supabase: { createClient: () => ({ auth }) },
  }
  const document = {
    getElementById(id) { return ['app','portalApp'].includes(id) ? root : null },
    querySelector(selector) { return selector === '.loading' && pending ? {} : null },
  }
  const location = { reload() { state.reloads += 1 } }
  return { context:{ console, document, location, Object, Promise, setTimeout, window }, state, window }
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
  const { context, state } = recoveryContext({ pending:true })
  vm.runInNewContext(recoveryScript(), context)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.match(state.html, /Unable to open the portal/)
  assert.match(state.html, /data-init-retry/)
  assert.equal(typeof state.retry, 'function')
  state.retry()
  assert.equal(state.reloads, 1)
})

test('Production bundle shape accepts the recovery injection and portal URL replacement', t => {
  const fixturePaths = ['/tmp/adminbundle.html', '/tmp/attbundle.html']
  if (fixturePaths.some(path => !existsSync(path))) {
    t.skip('Live decompressed bundle fixtures are not present')
    return
  }
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

test('Vercel routing keeps the new portal URL canonical', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.equal(config.redirects[0].destination, 'https://portal.adscope.net/')
  assert.equal(config.rewrites[0].destination, '/attendance/')
  assert.equal(config.rewrites[0].has[0].key, 'host')
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

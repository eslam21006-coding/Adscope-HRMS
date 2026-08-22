import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const portal = fs.readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('employee portal JavaScript parses', () => {
  assert.doesNotThrow(() => new Function(portal));
});

test('portal bounds startup, data loads and attendance actions', () => {
  assert.match(portal, /REQUEST_TIMEOUT_MS\s*=\s*15000/);
  assert.match(portal, /withTimeout\(client\.auth\.getSession\(\)\)/);
  assert.match(portal, /withTimeout\(client\.rpc\('get_my_attendance_profile'\)\)/);
  assert.match(portal, /withTimeout\(client\.rpc\('get_my_attendance_state'\)\)/);
  assert.match(portal, /withTimeout\(client\.functions\.invoke\('attendance-event'/);
});

test('portal never exposes the generic Edge Function non-2xx error', () => {
  assert.match(portal, /non-2xx\|edge function\|functionshttperror/i);
  assert.match(portal, /The HR service could not be reached\. Check your connection and try again\./);
  assert.match(portal, /Something went wrong\. Refresh the portal and try again\./);
  assert.doesNotMatch(portal, /return\s+raw\.replaceAll/);
});

test('portal has bounded recovery with Retry instead of an endless loading screen', () => {
  assert.match(portal, /Unable to open attendance/);
  assert.match(portal, /id="retryPortal"/);
  assert.match(portal, /The page stopped waiting instead of remaining on a loading screen\./);
  assert.match(portal, /bootOnce\(\)\.catch/);
});

test('portal reloads pages restored from browser back-forward cache', () => {
  assert.match(portal, /addEventListener\('pageshow'/);
  assert.match(portal, /event\.persisted/);
  assert.match(portal, /location\.reload\(\)/);
});

test('Vercel serves HRMS files without stale caching', () => {
  const globalHeaders = vercel.headers.find(entry => entry.source === '/(.*)');
  assert.ok(globalHeaders, 'global headers should exist');
  const cacheHeader = globalHeaders.headers.find(header => header.key.toLowerCase() === 'cache-control');
  assert.equal(cacheHeader?.value, 'no-store, max-age=0');
});

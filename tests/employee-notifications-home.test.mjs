import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const portal = readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');

function isolate(startMarker, endMarker, exported, context = {}) {
  const start = portal.indexOf(startMarker);
  const end = portal.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Cannot isolate ${exported}`);
  return vm.runInNewContext(`${portal.slice(start, end)}\n${exported}`, context);
}

test('notification fetch uses the signed-in recipient ID in the actual database column', async () => {
  const calls = [];
  const builder = {
    select(cols) { calls.push(['select', cols]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    limit(value) { calls.push(['limit', value]); return Promise.resolve({ data: [], error: null }); }
  };
  const loadNotifications = isolate(
    'async function loadNotifications(', 'async function renderNotifications()', 'loadNotifications',
    {
      session: { user: { id: 'signed-in-user' } },
      client: { from(table) { calls.push(['from', table]); return builder; } },
      optionalQuery: async factory => {
        const response = await factory();
        return response.error ? { available: false, data: [] } : { available: true, data: response.data };
      }
    }
  );
  const result = await loadNotifications(12);
  assert.equal(result.available, true);
  assert.deepEqual(calls.map(x => [...x]), [
    ['from', 'notifications'],
    ['select', '*'],
    ['eq', 'recipient_user_id', 'signed-in-user'],
    ['limit', 12]
  ]);
});

test('Home never reports no urgent items when violations could not be loaded', async () => {
  const home = isolate('async function renderHome()', 'async function renderAttendance()', 'renderHome', {
    ownRows: async table => ({ data: [], available: table !== 'violations' }),
    loadNotifications: async () => ({ data: [], available: false }),
    currentState: () => 'open',
    attendance: { shift_date: '2026-10-20', shift: { name: 'Day shift' } },
    profile: {},
    localDate: () => '2026-10-20',
    esc: value => String(value),
    badge: () => ''
  });
  const html = await home();
  assert.match(html, /Some alerts could not be checked/);
  assert.doesNotMatch(html, /<strong>No urgent items<\/strong>/);
  assert.match(html, /<span>Unread notifications<\/span><strong>—<\/strong>/);
});

test('mark-as-read calls recipient-scoped server RPC and reloads notifications', async () => {
  const calls = [];
  const button = { dataset: { markNotificationRead: 'test-notification-id' }, disabled: false, textContent: 'Mark as read' };
  const bindNotifications = isolate(
    'function bindNotifications(content)', 'function bindAttendance(content)', 'bindNotifications',
    {
      client: { rpc: async (name, args) => { calls.push([name, { ...args }]); return { error: null }; } },
      withTimeout: async promise => promise,
      loadPage: page => calls.push(['loadPage', page]),
      toast: () => {},
      friendlyError: () => 'Request failed'
    }
  );
  bindNotifications({ querySelectorAll: () => [button] });
  await button.onclick();
  assert.deepEqual(calls.map(([name, args]) => [name, args]), [
    ['mark_notification_read', { p_notification_id: 'test-notification-id' }],
    ['loadPage', 'notifications']
  ]);
});

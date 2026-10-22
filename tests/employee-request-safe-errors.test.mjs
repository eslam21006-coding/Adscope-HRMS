import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const portal = readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');

// Exercise the actual friendlyError implementation without booting the full DOM.
const start = portal.indexOf('function friendlyError(error)');
const end = portal.indexOf('function loading(', start);
assert.ok(start >= 0 && end > start, 'Cannot isolate the portal error handler');
const friendlyError = vm.runInNewContext(`${portal.slice(start, end)}\nfriendlyError`);

test('permission/leave/advance rejection messages use fixed, understandable text', () => {
  const known = [
    ['Only an Owner can submit a request for another employee', 'Your account cannot submit this request. Contact an Owner if the issue continues.'],
    ['Requested start time is required', 'Select the requested start time.'],
    ['Requested leave time is required', 'Select the requested end time.'],
    ['Enter a corrected check-in or check-out time', 'Enter at least one corrected attendance time.'],
    ['Another pending or approved leave overlaps these dates', 'A pending or approved leave request already covers these dates.'],
    ['Insufficient leave balance', 'This request cannot be submitted with the current available balance.'],
    ['Unsupported currency', 'The selected currency is not supported.'],
    ['Appeal reason is required', 'Enter a reason for your appeal.'],
    ['Reason is required', 'Select a date and enter a reason.'],
    ['An active employee account is required', 'Your employee account is not active for Employee Portal access. Contact an Owner.'],
    ['Case not found', 'This case could not be found. Refresh the page and try again.'],
    ['Incident not found', 'This case could not be found. Refresh the page and try again.']
  ];
  for (const [raw, expected] of known) {
    assert.equal(friendlyError({ message: raw }), expected);
  }
});

test('unknown provider or technical failures never echo raw messages', () => {
  for (const raw of [
    'SELECT internal_account FROM private_table WHERE secret = abc',
    'Request failed for user@company.example record 11111111-1111-1111-1111-111111111111',
    'invalid input syntax for type uuid: abc123'
  ]) {
    const message = friendlyError({ message: raw });
    assert.equal(message, 'Something went wrong. Refresh the portal and try again.');
    assert.ok(!message.includes('SELECT'));
    assert.ok(!message.includes('@'));
  }
});

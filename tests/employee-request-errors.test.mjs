import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const index = readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../attendance/request-error-runtime.js', import.meta.url), 'utf8');

test('request error runtime loads before the Employee Portal', () => {
  assert.ok(index.indexOf('/attendance/request-error-runtime.js') > index.indexOf('/attendance/portal-compat.js'));
  assert.ok(index.indexOf('/attendance/request-error-runtime.js') < index.indexOf('/attendance/portal.js'));
});

test('generic request failures are replaced with safe actionable messages', () => {
  assert.match(runtime, /Something went wrong\\\. Refresh the portal and try again/);
  assert.match(runtime, /Your Employee Portal account is not authorized to submit this request/);
  assert.match(runtime, /A matching request already exists/);
  assert.match(runtime, /This request overlaps an existing request or attendance record/);
  assert.match(runtime, /code === 'P0001'/);
});

test('technical database details are never shown to employees', () => {
  assert.match(runtime, /technicalPattern/);
  assert.match(runtime, /sql\|postgres\|postgrest\|schema\|constraint\|column\|relation\|table/);
  assert.match(runtime, /replace\(\/[0-9a-f]/);
});

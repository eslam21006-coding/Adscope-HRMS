import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const index = readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');
const compat = readFileSync(new URL('../attendance/portal-compat.js', import.meta.url), 'utf8');

test('full Employee Portal navigation is present', () => {
  for (const label of ['Home', 'Attendance', 'Requests', 'Leave', 'Advances', 'Violations', 'Notifications', 'Profile']) {
    assert.match(portal, new RegExp(`['\"]${label}['\"]`));
  }
});

test('production compatibility layer loads before the portal', () => {
  assert.ok(index.indexOf('/attendance/portal-compat.js') < index.indexOf('/attendance/portal.js'));
});

test('salary advance history maps to the production advances table', () => {
  assert.match(compat, /table === 'advance_requests' \? 'advances' : table/);
});

test('employee self-service RPCs use production parameter names and employee scope', () => {
  assert.match(compat, /p_requested_start_time/);
  assert.match(compat, /p_requested_end_time/);
  assert.match(compat, /p_corrected_check_in/);
  assert.match(compat, /p_corrected_check_out/);
  assert.match(compat, /p_employee_id: currentEmployeeId/);
  assert.match(compat, /p_document_path/);
  assert.match(compat, /p_deduction_month/);
});

test('request retries reuse the same in-flight production RPC instead of creating duplicates', () => {
  assert.match(compat, /const requestCache = new Map\(\)/);
  assert.match(compat, /REQUEST_DEDUPE_MS = 120000/);
  assert.match(compat, /return cached\.promise/);
  assert.match(compat, /dedupedRpc\(originalRpc, name, normalized\)/);
});

test('attendance correction wall-clock values are reinterpreted in the organization timezone', () => {
  assert.match(compat, /normalizeCorrectionTimestamp/);
  assert.match(compat, /wallClockToZoneIso/);
  assert.match(compat, /window\.ADSCOPE_CONFIG\?\.timezone \|\| 'Africa\/Cairo'/);
});

test('history queries are ordered before limit for supported tables', () => {
  assert.match(compat, /attendance_days: 'attendance_date'/);
  assert.match(compat, /permission_requests: 'created_at'/);
  assert.match(compat, /advances: 'created_at'/);
  assert.match(compat, /target\.order\(orderColumns\[table\], \{ ascending: false \}\)\.limit\(limit\)/);
});

test('advance month default follows organization timezone', () => {
  assert.match(compat, /installTimezoneAwareAdvanceDefault/);
  assert.match(compat, /formatToParts/);
  assert.match(compat, /input\.value = `\$\{parts\.year\}-\$\{parts\.month\}`/);
});

test('notifications fall back from employee identity to signed-in user identity', () => {
  assert.match(compat, /wrapNotificationQuery/);
  assert.match(compat, /employeeFilter/);
  assert.match(compat, /\.eq\('user_id', getUserId\(\)\)/);
  assert.match(compat, /currentUserId = result\?\.data\?\.session\?\.user\?\.id/);
});

test('ordinary violation responses cannot fall through to an appeal-only RPC', () => {
  assert.match(compat, /const violationIntent = new Map\(\)/);
  assert.match(compat, /p\.p_response_type \|\| 'response'/);
  assert.match(compat, /Appeal-only workflow was not selected for this response/);
});

test('richer Employee Portal profile is optional and attendance remains the boot authority', () => {
  assert.match(compat, /get_my_attendance_profile/);
  assert.match(compat, /get_my_employee_portal_profile/);
  assert.match(compat, /Attendance profile remains sufficient for core portal boot/);
});

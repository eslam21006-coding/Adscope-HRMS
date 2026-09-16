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

test('violation response sends only the supported production arguments', () => {
  const section = compat.slice(compat.indexOf("name === 'submit_violation_response'"));
  assert.match(section, /p_violation_id/);
  assert.match(section, /p_response/);
  assert.doesNotMatch(section.split('return originalRpc(name, payload)')[0], /p_response_type/);
});

test('richer Employee Portal profile is optional and attendance remains the boot authority', () => {
  assert.match(compat, /get_my_attendance_profile/);
  assert.match(compat, /get_my_employee_portal_profile/);
  assert.match(compat, /Attendance profile remains sufficient for core portal boot/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const portal = fs.readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../attendance/styles.css', import.meta.url), 'utf8');

test('full Employee Portal JavaScript parses', () => {
  assert.doesNotThrow(() => new Function(portal));
});

test('employee workspace exposes all required employee sections', () => {
  for (const label of ['Home','Attendance','Requests','Leave','Salary Advances','Violations','Notifications','Profile']) {
    assert.match(portal, new RegExp(`['\"]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`));
  }
  assert.match(portal, /data-page=/);
  assert.match(portal, /mobile-nav/);
  assert.match(styles, /\.workspace/);
  assert.match(styles, /@media\(max-width:900px\)/);
});

test('full portal keeps the server-authoritative attendance lifecycle', () => {
  assert.match(portal, /rpc\('get_my_attendance_profile'\)/);
  assert.match(portal, /rpc\('get_my_attendance_state'\)/);
  assert.match(portal, /attendance\?\.allowed_actions/);
  assert.match(portal, /functions\.invoke\('attendance-event'/);
  assert.doesNotMatch(portal, /from\('attendance_events'\).*attendance_date/);
});

test('employee records are explicitly scoped to the signed-in employee', () => {
  assert.match(portal, /from\(table\)\.select\('\*'\)\.eq\('employee_id', id\)/);
  assert.match(portal, /from\('notifications'\)\.select\('\*'\)\.eq\('employee_id', id\)/);
  assert.match(portal, /from\('notifications'\)\.select\('\*'\)\.eq\('user_id', uid\)/);
});

test('employee request workflows call the existing server functions', () => {
  assert.match(portal, /submit_permission_request/);
  assert.match(portal, /submit_leave_request/);
  assert.match(portal, /submit_advance_request/);
  assert.match(portal, /Owner approval/);
  assert.match(portal, /Owner review/);
});

test('portal remains source-controlled and does not restore the corrupt bundle loader', () => {
  assert.match(page, /<link rel="stylesheet" href="\/attendance\/styles\.css">/);
  assert.match(page, /<script src="\/attendance\/portal\.js"><\/script>/);
  assert.doesNotMatch(page, /hrms-static-assets\?bundle=attendance/);
  assert.doesNotMatch(page, /DecompressionStream/);
});

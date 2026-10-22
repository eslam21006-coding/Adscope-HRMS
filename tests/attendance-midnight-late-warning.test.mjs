import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const portal = readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');
const loader = readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260810173000_midnight_attendance_and_late_warning.sql', import.meta.url), 'utf8');

test('employee portal reads server-authoritative cross-midnight attendance state', () => {
  assert.match(portal, /client\.rpc\('get_my_attendance_state'\)/);
  assert.match(portal, /attendance = attendanceResult\.data \|\| \{\}/);
  assert.match(portal, /attendance\?\.shift_date \|\| localDate\(\)/);
  assert.match(portal, /attendance\?\.previous_review/);
  assert.match(portal, /Current shift events/);
  assert.doesNotMatch(portal, /eq\('attendance_date',localDate\(\)\)/);
});

test('break checkout compatibility is enforced in the backend shift transition', () => {
  assert.match(portal, /allowed_actions/);
  assert.match(portal, /data-action="\$\{type\}"/);
  assert.match(migration, /last_type = 'BREAK_START' then p_event_type in \('BREAK_END', 'CHECK_OUT'\)/);
  assert.match(migration, /'BREAK_END',[\s\S]*'checkout_while_on_break'/);
  assert.match(migration, /Break automatically ended when the employee checked out/);
});

test('older missing checkouts go to Owner review before another shift', () => {
  assert.match(migration, /attendance_date < today_date - 1/);
  assert.match(migration, /status = 'missing_checkout'/);
  assert.match(migration, /worked_minutes = 0/);
  assert.match(migration, /overtime_minutes = 0/);
  assert.match(migration, /app_private\.notify_owners[\s\S]*attendance_review_required/);
  assert.match(migration, /MISSING_CHECKOUT_REVIEW_REQUIRED/);
});

test('late full-time check-in creates a warning, not a disciplinary sanction', () => {
  assert.match(migration, /e\.employment_type = 'full_time'/);
  assert.match(migration, /raw_late_minutes, 0\) > coalesce\(day_row\.grace_minutes, 0\)/);
  assert.match(migration, /late_approval, 'none'::public\.approval_status\) <> 'approved'/);
  assert.match(migration, /app_private\.notify_employee[\s\S]*late_check_in_warning[\s\S]*not a disciplinary warning/);
  assert.match(migration, /LATE_CHECK_IN_WARNING/);
  assert.doesNotMatch(migration, /insert into public\.violations/i);
});

test('attendance clock shares one live top-clock timer and updates each second', () => {
  assert.match(portal, /clockTimer = setInterval\(updateTopClock, 1000\)/);
  assert.match(portal, /const attendanceClock = document\.getElementById\('attendanceClock'\)/);
  assert.match(portal, /if \(attendanceClock\) attendanceClock\.textContent/);
  assert.match(portal, /clearInterval\(clockTimer\)/);
});

test('portal serves the current source rather than an obsolete gzip loader', () => {
  assert.match(loader, /src="\/attendance\/portal\.js"/);
  assert.match(loader, /src="\/attendance\/portal-compat\.js"/);
  assert.match(portal, /review_warning|review_reason/);
  assert.match(portal, /late_warning/);
  assert.doesNotMatch(loader, /patchAttendanceBundle/);
});

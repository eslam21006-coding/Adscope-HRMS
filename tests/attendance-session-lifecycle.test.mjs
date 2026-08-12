import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = [
  '20260812100000_attendance_session_schema.sql',
  '20260812100200_attendance_soft_review_hard_expiry.sql',
  '20260812100500_attendance_session_actions.sql',
  '20260812101000_attendance_review_and_totals.sql',
  '20260812101500_quarantine_august_system_issue.sql',
].map(name => fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')).join('\n');
const portal = fs.readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');
const loader = fs.readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../supabase/functions/attendance-event/index.ts', import.meta.url), 'utf8');

test('attendance uses explicit session lifecycle and one open session per employee', () => {
  assert.match(migration, /session_state in \('not_started','open','closed','needs_review'\)/);
  assert.match(migration, /attendance_days_one_open_session_per_employee_idx/);
  assert.match(migration, /where session_state='open'/);
});

test('session uses a six-hour soft review threshold and an eighteen-hour hard expiry', () => {
  assert.match(migration, /p_check_in_at \+ interval '18 hours'/);
  assert.match(migration, /return v_review_after\+interval '6 hours'/);
  assert.match(migration, /Extended checkout: checkout was recorded beyond the normal shift-end plus six-hour window/);
  assert.match(migration, /Your checkout was recorded, but this unusually long shift needs Owner review/);
});

test('expired shifts become review records and stop blocking new days', () => {
  assert.match(migration, /ATTENDANCE_SESSION_EXPIRED/);
  assert.match(migration, /session_state='needs_review'/);
  assert.match(migration, /excluded_from_totals=true/);
  assert.match(migration, /will not block today''s attendance/);
});

test('server is authoritative for portal state and allowed buttons', () => {
  assert.match(portal, /rpc\('get_my_attendance_state'\)/);
  assert.match(portal, /attendance\?\.allowed_actions/);
  assert.doesNotMatch(portal, /from\('attendance_events'\).*attendance_date/);
  assert.match(migration, /'allowed_actions'/);
});

test('checkout while on break stays atomic at one timestamp', () => {
  assert.match(migration, /last_type='BREAK_START' and p_event_type='CHECK_OUT'/);
  assert.match(migration, /'BREAK_END',event_ts/);
  assert.match(migration, /day_id,p_event_type,event_ts/);
});

test('unresolved and system-error records are neutral in monthly hour totals', () => {
  assert.match(migration, /when ad\.excluded_from_totals then 0 else greatest\(coalesce\(ad\.worked_minutes,0\),0\) end/);
  assert.match(migration, /when ad\.is_test_record or ad\.excluded_from_totals or not ad\.scheduled_workday then 0/);
  assert.match(migration, /System attendance issues are pending Owner correction/);
});

test('raw events are preserved and Owner corrections use finalized values', () => {
  assert.match(migration, /manual_finalized=true/);
  assert.match(migration, /finalized_check_in_at/);
  assert.match(migration, /finalized_check_out_at/);
  assert.match(migration, /Owner finalized attendance values while preserving raw employee events/);
  assert.match(migration, /Only an Owner can review or finalize attendance corrections/);
});

test('known August 10 and 11 corrupted records are quarantined, not rewritten', () => {
  assert.match(migration, /employee_code::text in\('EMP002','EMP0010'\)/);
  assert.match(migration, /attendance_date in\(date '2026-08-10',date '2026-08-11'\)/);
  assert.match(migration, /SYSTEM_ATTENDANCE_ISSUE_QUARANTINED/);
  assert.doesNotMatch(migration, /delete from public\.attendance_events/i);
});

test('edge function returns readable structured attendance errors', () => {
  for (const code of ['ACTIVE_SHIFT_EXISTS','NO_ACTIVE_SHIFT','ATTENDANCE_REVIEW_REQUIRED','ATTENDANCE_ALREADY_COMPLETE','ATTENDANCE_ACTION_FAILED']) {
    assert.match(edge, new RegExp(code));
  }
  assert.match(portal, /error\.context/);
});

test('attendance loader no longer applies calendar-date compatibility rewriting', () => {
  assert.doesNotMatch(loader, /patchAttendanceBundle/);
  assert.doesNotMatch(loader, /previousDate/);
  assert.match(loader, /hrms-static-assets\?bundle=attendance/);
});

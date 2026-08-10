import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const portal = readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8')
const loader = readFileSync(new URL('../attendance/index.html', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260810173000_midnight_attendance_and_late_warning.sql', import.meta.url), 'utf8')

test('employee portal keeps an open prior-day shift visible after midnight', () => {
  assert.match(portal, /gte\('attendance_date',previous\)\.lte\('attendance_date',today\)/)
  assert.match(portal, /activeDate=dates\.find/)
  assert.match(portal, /profile\.attendance_date=activeDate\|\|today/)
  assert.match(portal, /Current shift events/)
  assert.doesNotMatch(portal, /eq\('attendance_date',localDate\(\)\)/)
})

test('employee can check out directly while on break', () => {
  assert.match(portal, /break:\['BREAK_END','CHECK_OUT'\]/)
  assert.match(migration, /last_type = 'BREAK_START' then p_event_type in \('BREAK_END', 'CHECK_OUT'\)/)
  assert.match(migration, /'BREAK_END',[\s\S]*'checkout_while_on_break'/)
  assert.match(migration, /Break automatically ended when the employee checked out/)
})

test('server prevents a second check-in while yesterday shift is still open', () => {
  assert.match(migration, /p_event_type = 'CHECK_IN'[\s\S]*check_in_at is not null[\s\S]*check_out_at is null/)
  assert.match(migration, /You still have an open shift from %\. Check out before starting a new shift/)
})

test('late full-time check-in creates an employee warning without becoming discipline', () => {
  assert.match(migration, /e\.employment_type = 'full_time'/)
  assert.match(migration, /raw_late_minutes, 0\) > coalesce\(day_row\.grace_minutes, 0\)/)
  assert.match(migration, /late_approval, 'none'::public\.approval_status\) <> 'approved'/)
  assert.match(migration, /app_private\.notify_employee/[\s\S]*late_check_in_warning/[\s\S]*not a disciplinary warning/)
  assert.match(migration, /LATE_CHECK_IN_WARNING/)
  assert.doesNotMatch(migration, /insert into public\.violations/i)
})

test('live loader patches the currently compiled attendance bundle', () => {
  assert.match(loader, /patchAttendanceBundle/)
  assert.match(loader, /select\('event_type,occurred_at,attendance_date'\)/)
  assert.match(loader, /break:\['BREAK_END','CHECK_OUT'\]/)
  assert.match(loader, /data\?\.late_warning/)
})

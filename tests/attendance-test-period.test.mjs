import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const testPeriodMigration = readFileSync(
  new URL('../supabase/migrations/20260803084821_mark_august_1_4_attendance_as_test_only.sql', import.meta.url),
  'utf8',
)
const intervalMigration = readFileSync(
  new URL('../supabase/migrations/20260803084953_fix_attendance_incident_month_interval.sql', import.meta.url),
  'utf8',
)

test('August 1-4 attendance is persistently marked as test-only', () => {
  assert.match(testPeriodMigration, /attendance_test_periods/)
  assert.match(testPeriodMigration, /date '2026-08-01'/)
  assert.match(testPeriodMigration, /date '2026-08-04'/)
  assert.match(testPeriodMigration, /add column if not exists is_test_record boolean not null default false/i)
  assert.match(testPeriodMigration, /attendance_days_test_flag/)
  assert.match(testPeriodMigration, /new\.is_test_record := v_reason is not null/)
  assert.match(testPeriodMigration, /TEST ONLY — excluded from final August attendance and payroll/)
})

test('Test attendance cannot block closure or create attendance incidents', () => {
  assert.match(testPeriodMigration, /close_attendance_period[\s\S]*?not ad\.is_test_record/)
  assert.match(testPeriodMigration, /payroll_preflight[\s\S]*?not ad\.is_test_record/)
  assert.match(testPeriodMigration, /flag_unauthorized_breaks[\s\S]*?not ad\.is_test_record/)
  assert.match(testPeriodMigration, /flag_unexcused_absences[\s\S]*?not ad\.is_test_record/)
})

test('Test attendance remains paid-neutral and cannot add payroll penalties or overtime', () => {
  assert.match(testPeriodMigration, /scheduled_workday and \(is_test_record or status in \('present','late'\)\)/)
  assert.match(testPeriodMigration, /scheduled_workday and not is_test_record and status='absent'/)
  assert.match(testPeriodMigration, /approved_overtime_minutes\) filter\(where not is_test_record\)/)
  assert.match(testPeriodMigration, /and not ad\.is_test_record/)
  assert.match(testPeriodMigration, /and not prior\.is_test_record/)
  assert.match(testPeriodMigration, /test_attendance_days_treated_as_paid_neutral/)
  assert.match(testPeriodMigration, /attendance_test_periods tp[\s\S]*?v\.violation_date between tp\.starts_on and tp\.ends_on/)
})

test('Attendance incident month boundaries use a valid PostgreSQL interval', () => {
  assert.match(intervalMigration, /interval '1 month - 1 day'/)
  assert.doesNotMatch(intervalMigration, /interval '1 month-1 day'/)
})

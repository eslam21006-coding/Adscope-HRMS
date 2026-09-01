import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260901131500_automate_attendance_month_end.sql', import.meta.url), 'utf8')

test('missed check-ins wait for a 24-hour employee correction window', () => {
  assert.match(migration, /return v_shift_end\+interval '24 hours'/)
  assert.match(migration, /p_now<v_deadline then return false/)
  assert.match(migration, /permission_requests[\s\S]*pr\.status='pending'[\s\S]*return false/)
  assert.match(migration, /leave_requests[\s\S]*status in \('draft','pending','approved'\)[\s\S]*return false/)
})

test('expired missed check-ins finalize attendance but not discipline', () => {
  assert.match(migration, /status='absent'[\s\S]*status_override='absent'/)
  assert.match(migration, /auto_resolution_code='missed_check_in_absence'/)
  assert.match(migration, /workflow_status,created_by[\s\S]*'draft'/)
  assert.match(migration, /Any disciplinary sanction still requires Owner review/)
  assert.doesNotMatch(migration, /workflow_status[\s\S]*'final'[\s\S]*auto_missed_check_in_absence/)
})

test('missing checkout keeps raw evidence and caps only finalized payroll attendance', () => {
  assert.match(migration, /d\.check_out_at is not null[\s\S]*return false/)
  assert.match(migration, /finalized_check_in_at=d\.check_in_at/)
  assert.match(migration, /finalized_check_out_at=v_cap/)
  assert.match(migration, /finalized_break_minutes=v_break/)
  assert.match(migration, /auto_resolution_code='missing_checkout_scheduled_cap'/)
  assert.match(migration, /No unverified overtime is credited/)
  assert.doesNotMatch(migration, /\n\s*check_out_at\s*=\s*v_cap/)
})

test('system issues and genuinely ambiguous records remain Owner exceptions', () => {
  assert.match(migration, /or d\.system_issue[\s\S]*return false/)
  assert.match(migration, /if v_cap<=d\.check_in_at then return false/)
  assert.match(migration, /system attendance issue requires Owner review/)
})

test('preflight does not label future scheduled days as employee failures', () => {
  assert.match(migration, /Payroll month is still in progress\. Attendance can be closed after/)
  assert.match(migration, /ad\.attendance_date<v_today/)
  assert.match(migration, /Future days are deliberately excluded here/)
})

test('only employee-submitted requests and real exceptions block payroll after defaults', () => {
  assert.match(migration, /Pending attendance or permission requests require Owner decision/)
  assert.match(migration, /Pending leave requests intersect this period/)
  assert.match(migration, /Unresolved violations or appeals exist for this period/)
  assert.match(migration, /routine attendance exception\(s\) were automatically resolved/)
})

test('attendance closure reuses full payroll readiness instead of a second inconsistent blocker list', () => {
  assert.match(migration, /v_preflight:=public\.payroll_preflight\(p\.id\)/)
  assert.match(migration, /if not coalesce\(\(v_preflight->>'ok'\)::boolean,false\)/)
  assert.match(migration, /Payroll preflight failed:/)
})

test('test employee is deactivated rather than deleted', () => {
  assert.match(migration, /upper\(e\.employee_code::text\)='EMPTEST'/)
  assert.match(migration, /set status='inactive'/)
  assert.doesNotMatch(migration, /delete from public\.employees/i)
})

test('August cleanup applies defaults without touching system issues', () => {
  assert.match(migration, /pp\.month_start=date '2026-08-01'/)
  assert.match(migration, /pp\.status='open'/)
  assert.match(migration, /perform app_private\.apply_elapsed_attendance_defaults/)
  assert.match(migration, /not ad\.system_issue/)
})

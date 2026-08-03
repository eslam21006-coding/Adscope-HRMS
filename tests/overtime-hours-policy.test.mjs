import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260803192000_separate_overtime_from_payroll_and_add_monthly_hours.sql', import.meta.url),
  'utf8',
)
const staticAssets = readFileSync(
  new URL('../supabase/functions/hrms-static-assets/index.ts', import.meta.url),
  'utf8',
)

test('overtime is removed from automatic payroll money', () => {
  assert.match(migration, /rename to generate_payroll_legacy_auto_overtime/)
  assert.match(migration, /component_type = 'overtime'/)
  assert.match(migration, /total_additions = round\(greatest\(0, pi\.total_additions - oa\.amount\)/)
  assert.match(migration, /net_salary = round\(pi\.net_salary - oa\.amount/)
  assert.match(migration, /automatic_overtime_payment', false/)
  assert.match(migration, /Owner-approved payroll adjustment required/)
})

test('only Owners can decide overtime while approved minutes remain derived', () => {
  assert.match(migration, /has_any_role\(array\['owner'\]::public\.app_role\[\]\)/)
  assert.match(migration, /Only an Owner can approve or reject overtime/)
  assert.match(migration, /new\.approved_overtime_minutes := case/)
  assert.match(migration, /when new\.overtime_approval = 'approved' then greatest\(coalesce\(new\.overtime_minutes,0\),0\)/)
  assert.match(migration, /attendance_days_owner_overtime_approval/)
})

test('monthly summary balances worked and adjusted required minutes', () => {
  assert.match(migration, /get_monthly_hours_summary/)
  assert.match(migration, /required_minutes integer/)
  assert.match(migration, /worked_minutes integer/)
  assert.match(migration, /balance_minutes integer/)
  assert.match(migration, /when ad\.is_test_record or not ad\.scheduled_workday then 0/)
  assert.match(migration, /in \('leave','holiday','weekend'\) then 0/)
  assert.match(migration, /ad\.scheduled_end <= ad\.scheduled_start/)
  assert.match(migration, /d\.actual_minutes[\s\S]*- coalesce\(sum\(d\.target_minutes/)
})

test('Admin bundle displays the monthly balance and protects overtime approval', () => {
  assert.match(staticAssets, /data-adscope-monthly-hours="owner-overtime-v1"/)
  assert.match(staticAssets, /get_monthly_hours_summary/)
  assert.match(staticAssets, /Required to date/)
  assert.match(staticAssets, /Worked/)
  assert.match(staticAssets, /Balance/)
  assert.match(staticAssets, /color:#268b54/)
  assert.match(staticAssets, /color:#c74b50/)
  assert.match(staticAssets, /Overtime approval — Owner only/)
  assert.match(staticAssets, /does not create payment/)
  assert.match(staticAssets, /monthly-hours-owner-overtime-v1/)
})
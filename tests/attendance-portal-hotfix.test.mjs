import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const staticAssets = readFileSync(new URL('../supabase/functions/hrms-static-assets/index.ts', import.meta.url), 'utf8')
const attendanceMigration = readFileSync(new URL('../supabase/migrations/20260803073000_fix_attendance_day_reuse_after_check_in.sql', import.meta.url), 'utf8')

test('initialization recovery recognizes the rendered employee portal', () => {
  assert.match(staticAssets, /\.login-page,\.shell,\.page,main,aside,nav,form,button,input/)
  assert.doesNotMatch(staticAssets, /querySelector\('\.login-page,\.shell,\.page'\)\);/)
})

test('attendance day reuse still returns the existing row after check-in', () => {
  assert.match(attendanceMigration, /on conflict \(employee_id, attendance_date\)[\s\S]*do update set/)
  assert.match(attendanceMigration, /returning id into v_day/)
  assert.doesNotMatch(attendanceMigration, /do update set[\s\S]*where public\.attendance_days\.check_in_at is null[\s\S]*returning id into v_day/)
})

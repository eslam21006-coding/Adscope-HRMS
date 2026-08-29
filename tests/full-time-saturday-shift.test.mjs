import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260829173000_full_time_saturday_shift.sql', import.meta.url), 'utf8')
const generationGuard = readFileSync(new URL('../supabase/migrations/20260829173500_full_time_saturday_generation_guard.sql', import.meta.url), 'utf8')
const actionMigration = readFileSync(new URL('../supabase/migrations/20260812100500_attendance_session_actions.sql', import.meta.url), 'utf8')

test('full-time employees use the Saturday 12pm to 9pm schedule', () => {
  assert.match(migration, /employment_type = 'full_time' and v_dow = 6/)
  assert.match(migration, /time '12:00:00'/)
  assert.match(migration, /time '21:00:00'/)
  assert.match(migration, /v_scheduled_break_minutes := case[\s\S]*then 60/)
  assert.match(migration, /v_required_hours := case[\s\S]*then 8/)
})

test('Saturday becomes a workday for full-time employees but official holidays still win', () => {
  assert.match(migration, /not v_is_holiday[\s\S]*v_is_full_time_saturday or v_dow = any\(v_shift\.workdays\)/)
  assert.match(migration, /when v_is_holiday then 'holiday'/)
})

test('the Saturday exception does not replace the normal shift grace period', () => {
  assert.match(migration, /v_shift\.grace_minutes/)
  assert.doesNotMatch(migration, /grace_minutes\s*=\s*0/)
})

test('early check-in remains allowed before the Saturday scheduled start', () => {
  assert.match(actionMigration, /when last_type is null then p_event_type='CHECK_IN'/)
  assert.doesNotMatch(actionMigration, /event_ts\s*<\s*.*scheduled_start/i)
  assert.doesNotMatch(actionMigration, /too early to check in/i)
})

test('already-generated Saturdays from 2026-08-29 are corrected and recalculated', () => {
  assert.match(migration, /attendance_date >= date '2026-08-29'/)
  assert.match(migration, /scheduled_start = time '12:00:00'/)
  assert.match(migration, /scheduled_end = time '21:00:00'/)
  assert.match(migration, /session_expires_at = case[\s\S]*attendance_session_expiry[\s\S]*time '21:00:00'/)
  assert.match(migration, /perform app_private\.recompute_attendance_day\(r\.id\)/)
})

test('future generated attendance rows are normalized on insert', () => {
  assert.match(generationGuard, /before insert on public\.attendance_days/)
  assert.match(generationGuard, /employment_type = 'full_time'/)
  assert.match(generationGuard, /extract\(dow from new\.attendance_date\)::integer <> 6/)
  assert.match(generationGuard, /new\.scheduled_workday := true/)
  assert.match(generationGuard, /new\.scheduled_start := time '12:00:00'/)
  assert.match(generationGuard, /new\.scheduled_end := time '21:00:00'/)
  assert.match(generationGuard, /new\.scheduled_break_minutes := 60/)
  assert.match(generationGuard, /new\.required_hours := 8/)
  assert.match(generationGuard, /if v_is_holiday then[\s\S]*return new/)
})

test('generation guard does not override later Owner-approved schedule updates', () => {
  assert.match(generationGuard, /before insert on public\.attendance_days/)
  assert.doesNotMatch(generationGuard, /before update/i)
})

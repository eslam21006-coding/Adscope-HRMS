import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260903113000_normalize_finalized_attendance_status.sql', import.meta.url), 'utf8')

test('finalized attendance clears stale unresolved override', () => {
  assert.ok(migration.includes('new.manual_finalized'))
  assert.ok(migration.includes('not coalesce(new.requires_owner_review,false)'))
  assert.ok(migration.includes("new.status_override in ('not_started','incomplete','missing_checkout','invalid')"))
  assert.ok(migration.includes('new.status_override:=null'))
})

test('historical finalized corrections are recomputed', () => {
  assert.ok(migration.includes('set status_override=null,updated_at=now()'))
  assert.ok(migration.includes('perform app_private.recompute_attendance_day(r.id)'))
  assert.ok(migration.includes('ATTENDANCE_FINALIZED_STATUS_NORMALIZED'))
})

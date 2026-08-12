import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminLoader = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const reviewRuntime = fs.readFileSync(new URL('../admin/attendance-session-review.js', import.meta.url), 'utf8');
const hardening = fs.readFileSync(new URL('../supabase/migrations/20260812101200_harden_attendance_review_validation.sql', import.meta.url), 'utf8');
const bundleMigration = fs.readFileSync(new URL('../supabase/migrations/20260812102000_compiled_attendance_session_portal.sql', import.meta.url), 'utf8');

test('admin loader preserves filters and loads Owner correction runtime', () => {
  assert.match(adminLoader, /attendance-filters\.js/);
  assert.match(adminLoader, /attendance-session-review\.js/);
});

test('Owner correction UI preserves raw events and uses secured review RPC', () => {
  assert.match(reviewRuntime, /from\('attendance_events'\)/);
  assert.match(reviewRuntime, /Raw recorded events/);
  assert.match(reviewRuntime, /rpc\('review_attendance_day'/);
  assert.match(reviewRuntime, /Finalize corrected attendance/);
});

test('system-issue correction does not silently reuse corrupted raw timestamps', () => {
  assert.match(hardening, /when d\.system_issue then coalesce\(r\.corrected_check_in,d\.finalized_check_in_at\)/);
  assert.match(hardening, /when d\.system_issue then coalesce\(r\.corrected_check_out,d\.finalized_check_out_at\)/);
});

test('finalization requires complete confirmed working times when status is automatic', () => {
  assert.match(hardening, /v_status is null or v_status not in/);
  assert.match(hardening, /Enter the final check-in and check-out times/);
});

test('compiled employee portal migration is deterministic and verifies stored payload', () => {
  assert.match(bundleMigration, /delete from app_private\.frontend_bundle_parts where bundle='attendance'/);
  assert.match(bundleMigration, /length\(v_payload\) <> 16992/);
  assert.equal((bundleMigration.match(/values \('attendance',/g)||[]).length,3);
});

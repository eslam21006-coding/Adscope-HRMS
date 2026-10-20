import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const compat = readFileSync(new URL('../attendance/portal-compat.js', import.meta.url), 'utf8');

function createHarness() {
  const calls = [];
  const client = {
    auth: {
      async getSession() {
        return { data: { session: { user: { id: 'test-user' } } }, error: null };
      }
    },
    from() { return {}; },
    async rpc(name, args = {}) {
      calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (name === 'get_my_attendance_profile') {
        return { data: { employee_id: 'test-employee', organization_id: 'test-org' }, error: null };
      }
      if (name === 'get_my_employee_portal_profile') {
        return { data: { employee_id: 'test-employee' }, error: null };
      }
      return { data: 'test-request-id', error: null };
    }
  };
  const window = {
    supabase: { createClient: () => client },
    ADSCOPE_CONFIG: { timezone: 'Africa/Cairo' },
    setTimeout() {}
  };
  const document = { documentElement: {}, querySelector() { return null; } };
  class MutationObserver { observe() {} }

  vm.runInNewContext(compat, { window, document, MutationObserver, Intl, Date, Map, Promise });
  return { client: window.supabase.createClient('test-url', 'test-publishable'), calls };
}

async function signedInClient() {
  const harness = createHarness();
  await harness.client.auth.getSession();
  await harness.client.rpc('get_my_attendance_profile');
  return harness;
}

test('employee late-start and early-leave RPCs never send an Owner-only employee ID', async () => {
  const { client, calls } = await signedInClient();
  await client.rpc('submit_permission_request', {
    p_request_type: 'late_start',
    p_request_date: '2026-10-19',
    p_reason: 'Finished an overnight shift',
    p_late_start_time: '11:30',
    p_employee_id: 'client-must-not-be-trusted'
  });
  await client.rpc('submit_permission_request', {
    p_type: 'early_leave',
    p_date: '2026-10-21',
    p_reason: 'Approved appointment',
    p_early_leave_time: '16:00'
  });
  const submitted = calls.filter(call => call.name === 'submit_permission_request');
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].args.p_request_type, 'late_start');
  assert.equal(submitted[0].args.p_requested_start_time, '11:30');
  assert.equal(submitted[1].args.p_request_type, 'early_leave');
  assert.equal(submitted[1].args.p_requested_end_time, '16:00');
  assert.ok(submitted.every(call => !Object.hasOwn(call.args, 'p_employee_id')));
});

test('employee leave and salary-advance RPCs also rely on authenticated server identity', async () => {
  const { client, calls } = await signedInClient();
  await client.rpc('submit_leave_request', {
    p_leave_type_id: 'test-leave-type',
    p_start_date: '2026-10-25',
    p_end_date: '2026-10-26',
    p_reason: 'Annual leave',
    p_employee_id: 'malicious-client-override'
  });
  await client.rpc('submit_advance_request', {
    p_amount: 1000,
    p_currency: 'EGP',
    p_deduction_month: '2026-11-01',
    p_reason: 'Advance requested',
    p_employee_id: 'malicious-client-override'
  });

  const leave = calls.find(call => call.name === 'submit_leave_request');
  const advance = calls.find(call => call.name === 'submit_advance_request');
  assert.equal(leave.args.p_start_date, '2026-10-25');
  assert.equal(advance.args.p_deduction_month, '2026-11-01');
  assert.equal(advance.args.p_amount, 1000);
  assert.equal(Object.hasOwn(leave.args, 'p_employee_id'), false);
  assert.equal(Object.hasOwn(advance.args, 'p_employee_id'), false);
});

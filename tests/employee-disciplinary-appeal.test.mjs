import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const portal = readFileSync(new URL('../attendance/portal.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261020115000_secure_employee_disciplinary_appeal.sql', import.meta.url), 'utf8');
const start = portal.indexOf('function bindViolationResponse(form)');
const end = portal.indexOf('async function record(type, button)', start);
assert.ok(start >= 0 && end > start);

function makeHarness(type, result = { error: null }) {
  const calls = [];
  const button = { disabled: false, textContent: 'Submit response' };
  const form = {
    dataset: { violationId: 'test-case-id' },
    fields: { response: 'I would like Owner review.', response_type: type },
    querySelector: () => button
  };
  class FormDataMock {
    constructor(target) { this.data = target.fields; }
    get(key) { return this.data[key]; }
  }
  const binding = vm.runInNewContext(`${portal.slice(start, end)}\nbindViolationResponse`, {
    FormData: FormDataMock,
    client: { rpc: async (name, payload) => { calls.push({ name, payload: JSON.parse(JSON.stringify(payload)) }); return result; } },
    withTimeout: async value => value,
    toast: (msg, level) => calls.push({ name: 'toast', message: msg, level }),
    loadPage: section => calls.push({ name: 'loadPage', section }),
    friendlyError: () => 'Request failed'
  });
  binding(form);
  return { calls, form, button };
}

test('appeal uses only the dedicated disciplinary appeal RPC', async () => {
  const h = makeHarness('appeal');
  await h.form.onsubmit({ preventDefault() {} });
  const submitted = h.calls.filter(call => call.name.startsWith('submit_'));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].name, 'submit_disciplinary_appeal');
  assert.deepEqual({ ...submitted[0].payload }, {
    p_violation_id: 'test-case-id',
    p_appeal_reason: 'I would like Owner review.',
    p_evidence: []
  });
});

test('ordinary response uses the response RPC and never the appeal RPC', async () => {
  const h = makeHarness('response');
  await h.form.onsubmit({ preventDefault() {} });
  const submitted = h.calls.filter(call => call.name.startsWith('submit_'));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].name, 'submit_violation_response');
  assert.deepEqual({ ...submitted[0].payload }, {
    p_violation_id: 'test-case-id',
    p_response: 'I would like Owner review.'
  });
});

test('an appeal failure does not fall back to an ordinary response', async () => {
  const h = makeHarness('appeal', { error: { message: 'The 24-hour appeal period has expired' } });
  await h.form.onsubmit({ preventDefault() {} });
  assert.equal(h.calls.filter(call => call.name.startsWith('submit_')).length, 1);
  assert.equal(h.button.disabled, false);
});

test('migration scopes appeal privilege to the existing server-checked function', () => {
  assert.match(migration, /ALTER FUNCTION public\.submit_disciplinary_appeal\(uuid, text, jsonb\) SECURITY DEFINER/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.submit_disciplinary_appeal/);
  assert.doesNotMatch(migration, /DISABLE ROW LEVEL SECURITY|CREATE POLICY/i);
});

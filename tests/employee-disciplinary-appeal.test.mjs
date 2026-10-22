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
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.submit_disciplinary_appeal/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /v\.appeal_deadline_at IS NULL OR NOW\(\) > v\.appeal_deadline_at/);
  assert.match(migration, /FROM anon;/);
  assert.doesNotMatch(migration, /employee_response\s*=/, 'appeal reason must not overwrite employee response');
  assert.match(migration, /recipient_user_id|employee_id = v_emp/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.submit_disciplinary_appeal/);
  assert.doesNotMatch(migration, /DISABLE ROW LEVEL SECURITY|CREATE POLICY/i);
});

test('device clock cannot block a timely appeal; server checks the deadline', () => {
  assert.match(portal, /String\(item\.workflow_status \|\| ''\)\.toLowerCase\(\) === 'notified' \? '1' : '0'/);
  assert.doesNotMatch(portal, /Date\.parse\(item\.appeal_deadline_at\)/);
  assert.match(portal, /The 24-hour appeal period has expired/);
});

test('appeal eligibility uses case state, not an untrusted client device clock', async () => {
  const start = portal.indexOf('async function renderViolations()');
  const end = portal.indexOf('async function loadNotifications(', start);
  assert.ok(start >= 0 && end > start);
  const render = vm.runInNewContext(`${portal.slice(start, end)}\nrenderViolations`, {
    ownRows: async () => ({
      available: true,
      data: [
        { id: 'case-notified', workflow_status: 'notified', appeal_deadline_at: '2000-01-01T00:00:00Z' },
        { id: 'case-review', workflow_status: 'under_review' },
        { id: 'case-final', workflow_status: 'final' }
      ]
    }),
    sortRows: rows => rows,
    esc: value => String(value ?? ''),
    badge: value => String(value ?? ''),
    sectionUnavailable: value => value
  });
  const markup = await render();
  assert.match(markup, /data-respond-violation="case-notified" data-appeal-allowed="1"/);
  assert.match(markup, /data-respond-violation="case-review" data-appeal-allowed="0"/);
  assert.doesNotMatch(markup, /data-respond-violation="case-final"/);
  // The server, not device Date.now(), rejects cases past their appeal deadline.
});

test('appeal is disabled for under-review incidents while response remains available', () => {
  const bindStart = portal.indexOf('function bindViolations(content)');
  const bindEnd = portal.indexOf('function isRpcMismatch(error)', bindStart);
  assert.ok(bindStart >= 0 && bindEnd > bindStart);
  const bindViolations = vm.runInNewContext(
    `${portal.slice(bindStart, bindEnd)}\nbindViolations`, {
      esc: value => String(value ?? ''),
      bindViolationResponse() {}
    }
  );
  const collectMarkup = eligibility => {
    const button = { dataset: { respondViolation: 'test-case', appealAllowed: eligibility } };
    const host = {
      innerHTML: '',
      querySelector() { return {}; },
      scrollIntoView() {}
    };
    bindViolations({
      querySelector: () => host,
      querySelectorAll: () => [button]
    });
    button.onclick();
    return host.innerHTML;
  };

  const notified = collectMarkup('1');
  assert.match(notified, /<option value="appeal">Appeal<\/option>/);
  assert.doesNotMatch(notified, /<option value="appeal" disabled>/);

  const underReview = collectMarkup('0');
  assert.match(underReview, /<option value="appeal" disabled>Appeal<\/option>/);
  assert.match(underReview, /<option value="response">Response<\/option>/);
});

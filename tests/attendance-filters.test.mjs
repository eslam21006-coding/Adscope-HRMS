import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const loader = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const filters = readFileSync(new URL('../admin/attendance-filters.js', import.meta.url), 'utf8');

test('Admin loader injects the external attendance filter script into the Admin bundle only', () => {
  assert.match(loader, /runtimePatch.*attendance-filters\.js/);
  assert.match(loader, /attendance-session-review\.js/);
  assert.match(loader, /html\.replace\(\/<\\\/body>\/i,runtimePatch\+'<\/body>'\)/);
});

test('attendance controls include date, employee, attended-only and clearing', () => {
  for (const text of ['data-attendance-date','data-attendance-employee','All employees','All attendance records','Attended only','data-attendance-reset']) {
    assert.ok(filters.includes(text), 'Missing '+text);
  }
  assert.match(filters, /row\.hidden=!show/);
  assert.match(filters, /employeeKey===filterState\.employee/);
  assert.match(filters, /details\.date===filterState\.date/);
});

test('selected month bounds limit date filters; resetting clears all criteria', () => {
  assert.match(filters, /dateInput\.min=bounds\.min/);
  assert.match(filters, /dateInput\.max=bounds\.max/);
  assert.match(filters, /target\.id==='activeMonth'/);
  assert.match(filters, /filterState=\{date:'',employee:'',mode:'all'\}/);
});

test('external attendance filter is read-only and valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(filters));
  assert.doesNotMatch(filters, /\.from\(|\.rpc\(|\.update\(|\.insert\(|\.delete\(/);
});

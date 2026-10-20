# Employee Portal Stabilization — Master Specification
Status: proposed for implementation / not released
Date: 2026-10-20
Repository: Adscope-HRMS
Scope: Employee Portal (Home, Attendance, Requests, Leave, Advances, Violations, Notifications, Profile) and corresponding Owner workflows.
Release strategy: separately reviewed tasks and PRs; one coordinated production release **only after** acceptance gates pass. If an urgent outage requires earlier release, request explicit Owner approval.

## 1. Problem statement and evidence

- 2026-10-19: employee Mohamed Abdelmenam (EMP002 in supplied screenshot) attempted a **late-start permission** for 2026-10-19 at 11:30 AM. He reported having finished work at 3:45 AM. Portal displayed `Something went wrong. Refresh the portal and try again.` No verified root cause yet, and do not assume the request failed to persist.
- Current `main` at `b5a053c...` contains `api/rpc-contract-diagnostic.js` and generic request failures. PR #22 is open, NOT merged; it only changes error presentation, not the proven backend cause. CodeRabbit/Codex flagged potential technical-data leakage and insufficient tests; **do not merge PR #22 as-is**.
- Code inspection identified: potential false "No urgent items" when optional queries fail; notifications lack a mark-read action; the violations form tries response RPC before appeal RPC, allowing an appeal to be recorded as an ordinary response. Treat untested production behavior as unverified.
- Prior read-only Supabase inspection was denied. Obtain authorized service access before database-specific assertions; no employee passwords, tokens, or browser secrets.

## 2. Invariants — never regress

- Admin Dashboard and every existing sidebar section must remain intact. Employees use Employee Portal; no extra admin permissions.
- Owners (Eslam and Rewan) alone approve/reject leave, late-start, early-leave, attendance correction and advances. HR admins/managers cannot bypass.
- Approved permissions affect **one date**, not recurring shift templates. Attendance corrections preserve evidence/audit; leave approval updates leave balance and attendance.
- Annual leave 15 paid working days in first employment year, 21 after year 1, eligible after six completed months; exclude scheduled weekends/official holidays. Five company-paid sick days/year, statutory treatment separate. Emergency leave up to seven/year and two consecutive working days/incident, paid and deducted from annual; review emergency absence before disciplinary classification.
- Approved salary advance creates exactly one deduction in the selected payroll period; rejected request creates none. Do not convert overtime into money without Owner approval.
- Absence without notice and unauthorized break (>10 minutes past authorized break) create reviewable incidents; no automatic final sanctions. Only one sanction per incident; allow employee response/appeal and Owner decision.
- Keep server-trusted organization/employee membership and row-level authorization; no trust in editable client identity. Apply organization timezone (default Africa/Cairo) and configured 12-/24-hour format in both portals, including cross-midnight sessions; full-time Saturday scheduled 12 PM–9 PM including 1-hour break, early check-in allowed.
- Locked monthly attendance correction follows existing record-only 48-hour correction mechanism and Owner-approved reopening; finalized payroll adjustments require Owner review. No destructive rewrites.
- All user-visible messages in clear English, with no SQL/provider/stack/IDs/secrets. Bounded waiting state + Retry. Preserve timestamps, audit decisions and notifications.

## 3. Work packages and acceptance criteria

### P0-A — Request submit pipeline (permission, correction, leave, advance)
1. Establish actual production RPC signatures, auth/role checks and table constraints using authorized read-only access. Compare source and live contracts. Correlate EMP002 event by time without exposing personal info. Determine whether the attempted request persisted.
2. Fix confirmed root causes, not just toasts. Normalize contract once, not blind multi-signature fallback. Server must infer caller's employee/organization ID from authenticated membership, not trust supplied `p_employee_id`. Reject inappropriate dates/times explicitly.
3. Use stable, server-enforced idempotency for request retries and accidental double-click; dedupe must survive timeout/reload and distinguish truly rejected vs uncertain result. On ambiguous failure, query own request history before retry. Show success only after server confirmation.
4. Validate late start (2026-10-19 11:30 AM scenario), early leave, check-in/out correction (including midnight and timezone), leave types/dates/balances, and advance amount/currency/month. Errors must be actionable, fixed-text or safely whitelisted, no provider raw body.
5. Owner sees exactly one pending request, approval/rejection updates only relevant records, creates both notification and audit log, and rejected requests change nothing.
6. Delete `api/rpc-contract-diagnostic.js` from release and do not deploy further public diagnostic endpoints.

### P0-B — Attendance and payroll-linked safeguards
1. Exercise check-in, break, end-break, check-out, late check-in, early check-in, overnight work, break across midnight, missing checkout, Saturday schedule, stale-session and offline/slow-network recovery.
2. Verify attendance history, worked time, +/- monthly required hours and Owner-only overtime approval; no automatic overtime pay.
3. Verify leave/permission/correction impact on the correct date, monthly lock, and finalized payroll adjustment review; reject duplicate payroll deductions.
4. Keep today's attendance usable when optional secondary views are unavailable.

### P1-C — Violations and appeals
1. Distinct `Response` and `Appeal` pathways. Choosing Appeal must never be silently submitted as Response; if backend appeal action unavailable, show unavailable state rather than misclassifying.
2. Verify category, allegation, evidence, warning number, notice, response/appeal window, Owner review, final decision, payroll effect, and immutable audit. Keep one sanction/incident.
3. No auto-final sanctions and no cross-employee exposure.

### P1-D — Home, Notifications and Profile
1. Home must distinguish `confirmed zero pending` from `unable to load pending items`. Do not display `No urgent items` when its underlying fetch failed.
2. Notifications should list own items with correct unread count, mark-read operation that persists via authorized server policy, navigate to target when available, and retain decision notifications.
3. Profile shows only currently signed-in employee data and correct timezone/time format, with safe not-found/access-disabled state. Profile must not leak company/private details.
4. Fail optional sections independently and offer Retry with bounded load; no infinite spinners.

### P1-E — Cross-cutting reliability, security and error handling
1. Remove or replace risky `MutationObserver` text rewriting approach in PR #22. Map known server business errors to stable messages; unknown failures use safe generic fallback. Never display arbitrary provider error text.
2. On each form disable-submit while pending and preserve entered data after error; server-side idempotency for retries; scoped correlation metadata only in restricted logs. Avoid toast staleness between sections.
3. Verify authorization and organization isolation for each page and each mutation; Owner-only decisions; no secrets in client or logs.
4. Honor configured timezone/12–24-hour format across form validation and display. Detect stale data/session and recover without repeated refresh loops.
5. Test desktop/mobile and slow/bad connectivity, empty states, date formats, clear accessible English statuses.

### P0-F — Full QA, release readiness and controlled rollout
1. Tests must execute actual error/contract/response logic, not only match source text. Include success, business rejection, auth rejection, backend timeout, uncertain prior submission, and repeated clicks.
2. Simulate all eight pages with separate employee A, employee B, Owner Eslam, Owner Rewan and non-Owner admin. Test data must be synthetic/isolated; no test absence, advance, leave, violation or payroll records in real employee accounts.
3. Use staging/preview for smoke tests and Owner review. Require passing automated tests, CodeRabbit review with high-priority findings resolved, security and regression review, and actual signed-in UAT (without handling passwords).
4. After approval, deploy one coordinated production release, verify live domain and commit, smoke test the same paths, check logs, document rollback and any data migration needed.
5. Rollback releases only after assessing schema/data compatibility; never drop/change production data to resolve frontend symptoms.

## 4. Test matrix (minimum)
| Section | Employee action | Server/Owner assertion | Failure case |
| --- | --- | --- | --- |
| Home | open, navigate | correct pending and unread counts | backend failure shows unavailable, not zero |
| Attendance | IN → BREAK → END BREAK → OUT; overnight | day/session/sums correct; Owner review when required | duplicate event, timeout, midnight |
| Requests | late start, early leave, correction | exactly 1 pending; Owner decision date-scoped and audited | overlap/duplicate/invalid date/auth |
| Leave | annual/emergency/sick/unpaid | correct working-day balance and attendance | ineligible/insufficient/overlap |
| Advances | submit month/currency/amount | Owner approval single deduction | duplicate/invalid month/rejected |
| Violations | submit response, submit appeal | distinct intention, status, audit and deadlines | appeal endpoint missing |
| Notifications | open, mark read | own notifications, persisted unread count | network failure/retry |
| Profile | open | own identity and schedule | disabled access/other employee |

## 5. Release gates / definition of done
- [ ] Verified root cause for 2026-10-19 late-start case and preservation of any existing request.
- [ ] Every form and read view passes functional test in preview under employee role.
- [ ] Both Owners can approve/reject; others cannot.
- [ ] No duplicate request or double payroll deduction after retry.
- [ ] Cross-midnight, Saturday, leave balances, advance/month-lock, audit and notifications unaffected.
- [ ] No raw technical details in portal; privacy and organization isolation verified.
- [ ] All automated tests pass, reviewer P0/P1 issues closed, mobile/desktop UAT signed off.
- [ ] Production deployment and live smoke test documented.

## 6. Scope control and execution
- One master spec, individual work items, small reviewable PRs, one consolidated release after sign-off.
- Do not merge PR #22 unchanged; incorporate only reviewed and tested changes. Remove the temporary production RPC diagnostics.
- Do not modify production policies, finalize payroll, issue sanctions or rewrite employee attendance without specific Owner approval.
- If backend inspection/permissions remain blocked, progress with source/tests but record *server checks blocked*; cannot claim functional completion.

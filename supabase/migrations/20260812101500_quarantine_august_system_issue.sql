-- Known August 10/11 records affected by the verified portal date-boundary bug.
-- Preserve every raw event, but remove corrupted calculations until an Owner finalizes the true times.
update public.attendance_days ad
set
  session_state='needs_review',
  requires_owner_review=true,
  system_issue=true,
  excluded_from_totals=true,
  status_override='invalid',
  status='invalid',
  worked_minutes=0,
  overtime_minutes=0,
  approved_overtime_minutes=0,
  deductible_late_minutes=0,
  review_reason=case
    when ad.attendance_date=date '2026-08-10' then 'System attendance issue: August 11 portal actions were attached to the still-open August 10 session. Confirm the actual August 10 times before finalizing.'
    else 'System attendance issue: August 11 attendance could not start cleanly because the previous session remained open. Confirm the actual August 11 check-in, check-out and break time.'
  end,
  closed_at=coalesce(ad.closed_at,ad.check_out_at,now()),
  updated_at=now()
from public.employees e
join public.organizations o on o.id=e.organization_id and o.code='ADSCOPE'
where ad.employee_id=e.id
  and e.employee_code::text in('EMP002','EMP0010')
  and ad.attendance_date in(date '2026-08-10',date '2026-08-11')
  and not ad.is_test_record;

-- Audit the known system-issue quarantine without changing raw attendance_events.
insert into public.audit_logs(organization_id,actor_user_id,actor_role,action,entity_type,entity_id,new_values,reason)
select ad.organization_id,null,null,'SYSTEM_ATTENDANCE_ISSUE_QUARANTINED','attendance_day',ad.id::text,
  jsonb_build_object('employee_id',ad.employee_id,'attendance_date',ad.attendance_date,'excluded_from_totals',true,'requires_owner_review',true),
  'Verified August 10/11 portal session-boundary defect. Raw attendance events were preserved; calculated hours were quarantined pending Owner correction.'
from public.attendance_days ad
join public.employees e on e.id=ad.employee_id
join public.organizations o on o.id=ad.organization_id and o.code='ADSCOPE'
where e.employee_code::text in('EMP002','EMP0010')
  and ad.attendance_date in(date '2026-08-10',date '2026-08-11')
  and ad.system_issue
  and not exists(
    select 1 from public.audit_logs a
    where a.entity_type='attendance_day' and a.entity_id=ad.id::text and a.action='SYSTEM_ATTENDANCE_ISSUE_QUARANTINED'
  );

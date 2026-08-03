create table if not exists app_private.attendance_test_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  reason text not null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint attendance_test_periods_valid_range check (ends_on >= starts_on),
  constraint attendance_test_periods_unique_range unique (organization_id, starts_on, ends_on)
);

alter table public.attendance_days
  add column if not exists is_test_record boolean not null default false,
  add column if not exists test_reason text;

create index if not exists attendance_days_test_record_idx
  on public.attendance_days (organization_id, attendance_date)
  where is_test_record;

create or replace function app_private.sync_attendance_test_record()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $function$
declare
  v_reason text;
begin
  select tp.reason
    into v_reason
  from app_private.attendance_test_periods tp
  where tp.organization_id = new.organization_id
    and new.attendance_date between tp.starts_on and tp.ends_on
  order by tp.created_at desc
  limit 1;

  new.is_test_record := v_reason is not null;
  new.test_reason := v_reason;
  return new;
end;
$function$;

drop trigger if exists attendance_days_test_flag on public.attendance_days;
create trigger attendance_days_test_flag
before insert or update of organization_id, attendance_date
on public.attendance_days
for each row execute function app_private.sync_attendance_test_record();

insert into app_private.attendance_test_periods (
  organization_id, starts_on, ends_on, reason, created_by
)
select id, date '2026-08-01', date '2026-08-04',
       'TEST ONLY — attendance activity from August 1 through August 4, 2026 is excluded from payroll, penalties, overtime, absence classification and final monthly attendance decisions.',
       null
from public.organizations
where code = 'ADSCOPE'
on conflict (organization_id, starts_on, ends_on)
do update set reason = excluded.reason;

update public.attendance_days ad
set is_test_record = true,
    test_reason = tp.reason,
    notes = case
      when coalesce(ad.notes,'') ilike '%TEST ONLY — excluded from final August attendance and payroll%'
        then ad.notes
      else concat_ws(' · ', ad.notes, 'TEST ONLY — excluded from final August attendance and payroll')
    end
from app_private.attendance_test_periods tp
where ad.organization_id = tp.organization_id
  and ad.attendance_date between tp.starts_on and tp.ends_on;

create or replace function app_private.payroll_source_fingerprint(p_period uuid)
returns text
language sql
stable security definer
set search_path to 'public', 'app_private', 'extensions'
as $function$
 select encode(extensions.digest(concat_ws('|',p.id::text,
 coalesce((select max(updated_at)::text from public.employees where organization_id=p.organization_id),''),
 coalesce((select max(created_at)::text from public.employee_shift_assignments where organization_id=p.organization_id),''),
 coalesce((select max(created_at)::text from public.employee_compensation_history where organization_id=p.organization_id),''),
 coalesce((select max(updated_at)::text from public.attendance_days where payroll_period_id=p.id and not is_test_record),''),
 coalesce((select max(created_at)::text from app_private.attendance_test_periods where organization_id=p.organization_id and starts_on<=p.month_end and ends_on>=p.month_start),''),
 coalesce((select max(updated_at)::text from public.leave_requests where organization_id=p.organization_id and start_date<=p.month_end and end_date>=p.month_start),''),
 coalesce((select max(updated_at)::text from public.payroll_adjustments where organization_id=p.organization_id and payment_month=p.month_start),''),
 coalesce((select max(updated_at)::text from public.commissions where organization_id=p.organization_id and payment_month=p.month_start),''),
 coalesce((select max(updated_at)::text from public.violations where organization_id=p.organization_id and violation_date between p.month_start and p.month_end),''),
 coalesce((select max(updated_at)::text from public.advances where organization_id=p.organization_id and deduction_month=p.month_start),''),
 coalesce((select max(updated_at)::text from public.rules where organization_id=p.organization_id and is_active),''),
 coalesce((select updated_at::text from public.organizations where id=p.organization_id),'')),'sha256'),'hex')
 from public.payroll_periods p where p.id=p_period
$function$;

create or replace function public.close_attendance_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare p public.payroll_periods%rowtype; unresolved bigint;
begin
 if not app_private.has_any_role(array['owner','hr_admin']::public.app_role[]) then raise exception 'Not authorized'; end if;
 select * into p from public.payroll_periods where id=p_period_id and organization_id=app_private.current_organization_id() for update; if not found then raise exception 'Period not found'; end if; if p.status<>'open' then raise exception 'Attendance may only close from Open status'; end if;
 select count(*) into unresolved from public.attendance_days ad join public.employees e on e.id=ad.employee_id cross join lateral app_private.compensation_for_date_or_current(e.id,greatest(p.month_start,coalesce(e.hire_date,p.month_start)))c where ad.payroll_period_id=p.id and not ad.is_test_record and c.attendance_required and e.status='active' and ad.scheduled_workday and ad.status in('not_started','incomplete','missing_checkout','invalid');
 if unresolved>0 then raise exception '% unresolved attendance days remain',unresolved; end if;
 update public.payroll_periods set status='attendance_closed',attendance_closed_at=now(),attendance_closed_by=(select auth.uid()) where id=p.id;
 perform app_private.write_audit(p.organization_id,'CLOSE_ATTENDANCE','payroll_period',p.id::text,to_jsonb(p),jsonb_build_object('status','attendance_closed'),null,null);
end;$function$;

create or replace function public.payroll_preflight(p_period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare p public.payroll_periods%rowtype; blockers jsonb:='[]'::jsonb; warnings jsonb:='[]'::jsonb; r record;
begin
 if not app_private.has_any_role(array['owner','hr_admin','payroll_manager']::public.app_role[]) then raise exception 'Not authorized'; end if;
 select * into p from public.payroll_periods where id=p_period_id and organization_id=app_private.current_organization_id();
 if not found then raise exception 'Payroll period not found'; end if;
 for r in select e.id,e.employee_code,e.full_name,e.hire_date,e.basic_salary,e.compensation_type,e.attendance_required,e.current_shift_id,e.payroll_currency
 from public.employees e where e.organization_id=p.organization_id and e.status='active' and (e.hire_date is null or e.hire_date<=p.month_end) and (e.termination_date is null or e.termination_date>=p.month_start)
 loop
  select c.compensation_type,c.basic_salary,c.attendance_required,c.currency into r.compensation_type,r.basic_salary,r.attendance_required,r.payroll_currency
  from app_private.compensation_for_date_or_current(r.id,greatest(p.month_start,coalesce(r.hire_date,p.month_start))) c;
  if r.compensation_type<>'commission_only' and r.basic_salary<=0 then blockers:=blockers||jsonb_build_array(r.employee_code||' has no valid base salary'); end if;
  if r.attendance_required and r.current_shift_id is null then blockers:=blockers||jsonb_build_array(r.employee_code||' has no assigned shift'); end if;
  if r.payroll_currency is null then blockers:=blockers||jsonb_build_array(r.employee_code||' has no payroll currency'); end if;
  if exists(select 1 from public.commissions x where x.employee_id=r.id and x.payment_month=p.month_start and x.currency<>r.payroll_currency union all
    select 1 from public.payroll_adjustments x where x.employee_id=r.id and x.payment_month=p.month_start and x.currency<>r.payroll_currency union all
    select 1 from public.advances x where x.employee_id=r.id and x.deduction_month=p.month_start and x.currency<>r.payroll_currency union all
    select 1 from public.violations x where x.employee_id=r.id and x.violation_date between p.month_start and p.month_end and x.currency<>r.payroll_currency)
  then blockers:=blockers||jsonb_build_array(r.employee_code||' has a financial record in a different currency from the period compensation profile'); end if;
  if exists(select 1 from public.employee_compensation_history h where h.employee_id=r.id and h.effective_from between greatest(p.month_start,coalesce(r.hire_date,p.month_start))+1 and p.month_end)
  then blockers:=blockers||jsonb_build_array(r.employee_code||' has a mid-period compensation change; move it to month start or use an approved adjustment'); end if;
  if r.attendance_required and not exists(select 1 from public.attendance_days ad where ad.payroll_period_id=p.id and ad.employee_id=r.id and ad.scheduled_workday and not ad.is_test_record)
  then blockers:=blockers||jsonb_build_array(r.employee_code||' has no generated non-test attendance schedule'); end if;
 end loop;
 for r in select e.employee_code,count(*) filter(where ad.status in ('not_started','incomplete','missing_checkout','invalid') and not ad.is_test_record) as unresolved
 from public.attendance_days ad join public.employees e on e.id=ad.employee_id
 where ad.payroll_period_id=p.id and e.status='active' and e.attendance_required group by e.employee_code
 having count(*) filter(where ad.status in ('not_started','incomplete','missing_checkout','invalid') and not ad.is_test_record)>0
 loop blockers:=blockers||jsonb_build_array(r.employee_code||' has '||r.unresolved||' unresolved attendance day(s)'); end loop;
 if exists(select 1 from public.leave_requests where organization_id=p.organization_id and status in ('draft','pending') and start_date<=p.month_end and end_date>=p.month_start) then blockers:=blockers||jsonb_build_array('Pending leave requests intersect this period'); end if;
 if exists(select 1 from public.commissions where organization_id=p.organization_id and status='pending' and payment_month=p.month_start) then blockers:=blockers||jsonb_build_array('Pending commissions exist for this period'); end if;
 if exists(select 1 from public.violations v where v.organization_id=p.organization_id and v.violation_date between p.month_start and p.month_end and (v.workflow_status in ('notified','under_review') or v.appeal_status='pending') and not exists(select 1 from app_private.attendance_test_periods tp where tp.organization_id=v.organization_id and v.violation_date between tp.starts_on and tp.ends_on)) then blockers:=blockers||jsonb_build_array('Unresolved violations or appeals exist for this period'); end if;
 if not exists(select 1 from public.attendance_days where payroll_period_id=p.id and not is_test_record) then warnings:=warnings||jsonb_build_array('No non-test attendance days have been generated for this period'); end if;
 if exists(select 1 from public.attendance_days where payroll_period_id=p.id and is_test_record) then warnings:=warnings||jsonb_build_array('Test attendance records exist and are excluded from payroll and attendance closure'); end if;
 return jsonb_build_object('ok',jsonb_array_length(blockers)=0,'blockers',blockers,'warnings',warnings);
end;$function$;

create or replace function public.flag_unauthorized_breaks(p_month_start date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'app_private', 'extensions'
as $function$
declare v_org uuid:=app_private.current_organization_id(); v_end date:=(p_month_start+interval '1 month-1 day')::date; v_type uuid; v_tolerance int; r record; v_incidents int:=0; v_id uuid;
begin
 if not app_private.has_any_role(array['owner']::public.app_role[]) then raise exception 'Only an Owner can classify unauthorized breaks'; end if;
 select unauthorized_break_tolerance_minutes into v_tolerance from public.organization_settings where organization_id=v_org;
 select id into v_type from public.violation_types where organization_id=v_org and upper(code::text)='UNAUTH_BREAK' and is_active limit 1;
 if v_type is null then raise exception 'Unauthorized Break violation type is not configured'; end if;
 for r in
  select ad.id,ad.employee_id,ad.attendance_date,ad.break_minutes,ad.scheduled_break_minutes
  from public.attendance_days ad join public.employees e on e.id=ad.employee_id and e.organization_id=ad.organization_id
  where ad.organization_id=v_org and ad.attendance_date between p_month_start and least(v_end,current_date)
    and not ad.is_test_record and ad.scheduled_workday and e.status='active'
    and ad.break_minutes>ad.scheduled_break_minutes+coalesce(v_tolerance,10)
 loop
  if not exists(select 1 from public.violations v where v.employee_id=r.employee_id and v.violation_date=r.attendance_date and v.violation_type_id=v_type and v.workflow_status<>'rejected') then
    v_id:=gen_random_uuid();
    insert into public.violations(id,organization_id,violation_code,employee_id,violation_type_id,violation_date,description,workflow_status,created_by)
    values(v_id,v_org,('BRK-'||to_char(r.attendance_date,'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,5)))::citext,r.employee_id,v_type,r.attendance_date,'Recorded break time exceeded the scheduled break plus the configured tolerance. Actual break: '||r.break_minutes||' minutes; scheduled: '||r.scheduled_break_minutes||' minutes.','draft',(select auth.uid()));
    update public.attendance_days set notes=concat_ws(' · ',notes,'Unauthorized break threshold exceeded — Owner review required') where id=r.id;
    v_incidents:=v_incidents+1;
  end if;
 end loop;
 return jsonb_build_object('investigation_drafts_created',v_incidents,'tolerance_minutes',v_tolerance);
end $function$;

create or replace function public.flag_unexcused_absences(p_month_start date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'app_private', 'extensions'
as $function$
declare v_org uuid:=app_private.current_organization_id(); v_end date:=(p_month_start+interval '1 month-1 day')::date; v_type uuid; r record; v_count int:=0; v_incidents int:=0; v_id uuid;
begin
 if not app_private.has_any_role(array['owner']::public.app_role[]) then raise exception 'Only an Owner can classify unexcused absences'; end if;
 select id into v_type from public.violation_types where organization_id=v_org and upper(code::text)='ABSENCE_NO_NOTICE' and is_active limit 1;
 if v_type is null then raise exception 'Absence Without Notice violation type is not configured'; end if;
 for r in
  select ad.id,ad.employee_id,ad.attendance_date,e.full_name
  from public.attendance_days ad join public.employees e on e.id=ad.employee_id and e.organization_id=ad.organization_id
  where ad.organization_id=v_org and ad.attendance_date between p_month_start and least(v_end,current_date-1)
    and not ad.is_test_record and ad.scheduled_workday and e.status='active' and e.attendance_required
    and ad.check_in_at is null and ad.status in('not_started','incomplete')
    and not exists(select 1 from public.leave_requests lr where lr.employee_id=ad.employee_id and lr.status in('pending','approved') and ad.attendance_date between lr.start_date and lr.end_date)
    and not exists(select 1 from public.permission_requests pr where pr.employee_id=ad.employee_id and pr.request_date=ad.attendance_date and pr.status in('pending','approved'))
  for update of ad
 loop
  update public.attendance_days set status='absent',status_override='absent',notice_provided=false,notes=concat_ws(' · ',notes,'Classified as absence without notice — Owner review required') where id=r.id;
  v_count:=v_count+1;
  if not exists(select 1 from public.violations v where v.employee_id=r.employee_id and v.violation_date=r.attendance_date and v.violation_type_id=v_type and v.workflow_status<>'rejected') then
    v_id:=gen_random_uuid();
    insert into public.violations(id,organization_id,violation_code,employee_id,violation_type_id,violation_date,description,workflow_status,created_by)
    values(v_id,v_org,('ABS-'||to_char(r.attendance_date,'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,5)))::citext,r.employee_id,v_type,r.attendance_date,'No attendance event, approved leave or approved permission was recorded for the scheduled workday.','draft',(select auth.uid()));
    v_incidents:=v_incidents+1;
  end if;
 end loop;
 return jsonb_build_object('attendance_days_classified',v_count,'investigation_drafts_created',v_incidents);
end $function$;

create or replace function public.generate_payroll(p_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare
 p public.payroll_periods%rowtype; org public.organizations%rowtype; pre jsonb; run_id uuid; gen integer;
 e record; comp record; item_id uuid; scheduled_days numeric; full_days numeric; cal_days numeric; eligible_days numeric;
 avg_hours numeric; shift_name text; daily_rate numeric; hourly_rate numeric; base_salary numeric;
 present_days numeric; absent_days numeric; paid_leave_days numeric; unpaid_leave_days numeric; raw_late integer; approved_ot integer;
 commission_add numeric; commission_claw numeric; bonus_add numeric; allowance_add numeric; reimbursement_add numeric;
 manual_ded numeric; advance_ded numeric; overtime_add numeric; absence_ded numeric; unpaid_leave_ded numeric;
 late_before numeric; violation_before numeric; late_applied numeric; violation_applied numeric; cap numeric; cap_reduction numeric;
 additions numeric; deductions numeric; net numeric; multiplier numeric; occurrence integer; penalty numeric;
 late_row record; violation_row record; trace jsonb; test_days numeric;
begin
 if not app_private.has_any_role(array['owner','payroll_manager']::public.app_role[]) then raise exception 'Not authorized'; end if;
 select * into p from public.payroll_periods where id=p_period_id and organization_id=app_private.current_organization_id() for update;
 if not found then raise exception 'Payroll period not found'; end if;
 if p.status='open' then raise exception 'Close attendance before generating payroll'; end if;
 if p.status in ('reviewed','approved','paid','locked') then raise exception 'Reopen payroll before regeneration'; end if;
 select * into org from public.organizations where id=p.organization_id;
 pre:=public.payroll_preflight(p.id);
 if not (pre->>'ok')::boolean then raise exception 'Payroll preflight failed: %',pre->'blockers'; end if;
 select coalesce(max(generation_number),0)+1 into gen from public.payroll_runs where payroll_period_id=p.id;
 insert into public.payroll_runs(organization_id,payroll_period_id,generation_number,status,source_fingerprint,generated_by)
 values(p.organization_id,p.id,gen,'calculated',app_private.payroll_source_fingerprint(p.id),(select auth.uid())) returning id into run_id;

 for e in
  select emp.*,d.name department_name from public.employees emp left join public.departments d on d.id=emp.department_id
  where emp.organization_id=p.organization_id and emp.status='active'
   and (emp.hire_date is null or emp.hire_date<=p.month_end)
   and (emp.termination_date is null or emp.termination_date>=p.month_start)
  order by emp.employee_code
 loop
  select * into comp from app_private.compensation_for_date_or_current(e.id,greatest(p.month_start,coalesce(e.hire_date,p.month_start)));
  if not found then raise exception 'No compensation profile for %',e.employee_code; end if;
  select count(*)::numeric, count(*) filter(where is_test_record and scheduled_workday)::numeric into scheduled_days,test_days from public.attendance_days where payroll_period_id=p.id and employee_id=e.id and scheduled_workday;
  full_days:=app_private.count_scheduled_service_days(e.id,p.month_start,p.month_end);
  cal_days:=(p.month_end-p.month_start+1)::numeric;
  eligible_days:=(least(p.month_end,coalesce(e.termination_date,p.month_end))-greatest(p.month_start,coalesce(e.hire_date,p.month_start))+1)::numeric;
  if comp.attendance_required then
   daily_rate:=case when full_days>0 then comp.basic_salary/full_days else 0 end;
   base_salary:=round(daily_rate*scheduled_days,2);
  else
   scheduled_days:=0; daily_rate:=0; base_salary:=round(comp.basic_salary*eligible_days/nullif(cal_days,0),2);
  end if;
  select coalesce(avg(nullif(ad.required_hours,0)) filter(where ad.scheduled_workday),8),
   case when count(distinct ad.shift_id) filter(where ad.scheduled_workday)=1 then max(s.name) filter(where ad.scheduled_workday)
        when count(distinct ad.shift_id) filter(where ad.scheduled_workday)>1 then 'Multiple shifts' else null end
  into avg_hours,shift_name from public.attendance_days ad left join public.shifts s on s.id=ad.shift_id
  where ad.payroll_period_id=p.id and ad.employee_id=e.id;
  hourly_rate:=case when daily_rate>0 then daily_rate/coalesce(nullif(avg_hours,0),8) else 0 end;
  select count(*) filter(where scheduled_workday and (is_test_record or status in ('present','late'))),
   count(*) filter(where scheduled_workday and not is_test_record and status='absent'),
   count(*) filter(where scheduled_workday and not is_test_record and status='leave' and coalesce(leave_paid,true)),
   count(*) filter(where scheduled_workday and not is_test_record and status='leave' and coalesce(leave_paid,false)=false),
   coalesce(sum(raw_late_minutes) filter(where scheduled_workday and not is_test_record),0),coalesce(sum(approved_overtime_minutes) filter(where not is_test_record),0)
  into present_days,absent_days,paid_leave_days,unpaid_leave_days,raw_late,approved_ot
  from public.attendance_days where payroll_period_id=p.id and employee_id=e.id;
  select coalesce(sum(commission_amount),0) into commission_add from public.commissions where employee_id=e.id and payment_month=p.month_start and status in ('approved','paid');
  select coalesce(sum(commission_amount),0) into commission_claw from public.commissions where employee_id=e.id and payment_month=p.month_start and status='clawed_back';
  select coalesce(sum(amount) filter(where adjustment_type='bonus'),0),coalesce(sum(amount) filter(where adjustment_type='allowance'),0),
   coalesce(sum(amount) filter(where adjustment_type='reimbursement'),0),coalesce(sum(amount) filter(where adjustment_type='deduction'),0)
  into bonus_add,allowance_add,reimbursement_add,manual_ded from public.payroll_adjustments where employee_id=e.id and payment_month=p.month_start and status='approved';
  bonus_add:=coalesce(bonus_add,0); allowance_add:=coalesce(allowance_add,0); reimbursement_add:=coalesce(reimbursement_add,0); manual_ded:=coalesce(manual_ded,0);
  select coalesce(sum(amount),0) into advance_ded from public.advances where employee_id=e.id and deduction_month=p.month_start and status='approved';
  multiplier:=org.overtime_multiplier;
  select coalesce(max(r.value),multiplier) into multiplier from public.rules r where r.organization_id=p.organization_id and r.is_active and r.rule_type='overtime_multiplier'
   and p.month_start between r.effective_from and coalesce(r.effective_to,p.month_end) and (r.department_id is null or r.department_id=e.department_id) and approved_ot/60.0>=r.threshold;
  select coalesce(sum(r.value),0) into penalty from public.rules r where r.organization_id=p.organization_id and r.is_active and r.rule_type='fixed_bonus'
   and p.month_start between r.effective_from and coalesce(r.effective_to,p.month_end) and (r.department_id is null or r.department_id=e.department_id);
  allowance_add:=allowance_add+coalesce(penalty,0);
  select coalesce(round(sum((ad.approved_overtime_minutes/60.0)*case when daily_rate>0 then daily_rate/coalesce(nullif(ad.required_hours,0),8) else 0 end*multiplier),2),0)
  into overtime_add from public.attendance_days ad where ad.payroll_period_id=p.id and ad.employee_id=e.id and not ad.is_test_record;
  absence_ded:=round(absent_days*daily_rate,2); unpaid_leave_ded:=round(unpaid_leave_days*daily_rate,2);
  late_before:=0;
  if p.month_start>=org.policy_effective_date then
   for late_row in select attendance_date from public.attendance_days where payroll_period_id=p.id and employee_id=e.id
    and not is_test_record and raw_late_minutes>greatest(grace_minutes,org.lateness_threshold_minutes) and not notice_provided and late_approval<>'approved' order by attendance_date
   loop
    select count(*)::integer into occurrence from public.attendance_days prior where prior.employee_id=e.id
     and not prior.is_test_record and prior.attendance_date between greatest(org.policy_effective_date,late_row.attendance_date-(org.recurrence_window_days-1)) and late_row.attendance_date
     and prior.raw_late_minutes>greatest(prior.grace_minutes,org.lateness_threshold_minutes) and not prior.notice_provided and prior.late_approval<>'approved';
    late_before:=late_before+round(daily_rate*case when occurrence=1 then 0 when occurrence=2 then .25 else .5 end,2);
   end loop;
  end if;
  violation_before:=0;
  for violation_row in select v.* from public.violations v where v.employee_id=e.id and v.violation_date between p.month_start and p.month_end and v.workflow_status='final' and v.appeal_status<>'pending'
    and not exists(select 1 from app_private.attendance_test_periods tp where tp.organization_id=v.organization_id and v.violation_date between tp.starts_on and tp.ends_on)
  loop
   penalty:=case when violation_row.direct_loss_amount>0 then violation_row.direct_loss_amount when violation_row.manual_fine_amount>0 then violation_row.manual_fine_amount else round(daily_rate*coalesce(violation_row.final_penalty_fraction,0),2) end;
   violation_before:=violation_before+penalty;
  end loop;
  cap:=round(base_salary*org.penalty_cap_percent/100.0,2); late_applied:=least(late_before,cap); violation_applied:=least(violation_before,greatest(0,cap-late_applied));
  cap_reduction:=greatest(0,late_before+violation_before-cap);
  additions:=round(coalesce(commission_add,0)+coalesce(bonus_add,0)+coalesce(allowance_add,0)+coalesce(reimbursement_add,0)+coalesce(overtime_add,0),2);
  deductions:=round(coalesce(commission_claw,0)+coalesce(absence_ded,0)+coalesce(unpaid_leave_ded,0)+coalesce(late_applied,0)+coalesce(manual_ded,0)+coalesce(violation_applied,0)+coalesce(advance_ded,0),2);
  net:=round(base_salary+additions-deductions,2);
  trace:=jsonb_build_object('overtime_multiplier',multiplier,'late_before_cap',late_before,'violations_before_cap',violation_before,'penalty_cap',cap,'cap_reduction',cap_reduction,'full_month_scheduled_days',full_days,'eligible_calendar_days',eligible_days,'average_required_hours',avg_hours,'compensation_source',comp.source,'source_fingerprint',app_private.payroll_source_fingerprint(p.id),'test_attendance_days_treated_as_paid_neutral',coalesce(test_days,0));
  insert into public.payroll_items(organization_id,payroll_run_id,employee_id,employee_code,employee_name,department_name,employment_type,compensation_type,attendance_required,shift_name,currency,basic_salary,scheduled_service_days,daily_rate,hourly_rate,present_days,absent_days,paid_leave_days,unpaid_leave_days,raw_late_minutes,approved_overtime_minutes,total_additions,total_deductions,penalty_cap,penalties_before_cap,penalty_cap_reduction,net_salary,calculation_trace)
  values(p.organization_id,run_id,e.id,e.employee_code::text,e.full_name,e.department_name,e.employment_type,comp.compensation_type,comp.attendance_required,shift_name,comp.currency,base_salary,scheduled_days,round(daily_rate,4),round(hourly_rate,4),present_days,absent_days,paid_leave_days,unpaid_leave_days,raw_late,approved_ot,additions,deductions,cap,late_before+violation_before,cap_reduction,net,trace) returning id into item_id;
  insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description,calculation) values(p.organization_id,item_id,'base_salary',base_salary,comp.currency,'Base salary',jsonb_build_object('monthly_salary',base_salary));
  if commission_add<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'commission',commission_add,comp.currency,'Approved commissions'); end if;
  if commission_claw<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'commission_clawback',-commission_claw,comp.currency,'Commission clawbacks'); end if;
  if overtime_add<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description,calculation) values(p.organization_id,item_id,'overtime',overtime_add,comp.currency,'Approved overtime',jsonb_build_object('minutes',approved_ot,'multiplier',multiplier)); end if;
  if absence_ded<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description,calculation) values(p.organization_id,item_id,'absence',-absence_ded,comp.currency,'Scheduled service days not provided',jsonb_build_object('days',absent_days,'daily_rate',daily_rate)); end if;
  if unpaid_leave_ded<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'unpaid_leave',-unpaid_leave_ded,comp.currency,'Unpaid leave'); end if;
  if late_applied<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'late_penalty',-late_applied,comp.currency,'Progressive lateness penalties'); end if;
  if manual_ded<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'manual_deduction',-manual_ded,comp.currency,'Approved manual deductions'); end if;
  if violation_applied<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'violation',-violation_applied,comp.currency,'Final policy violations'); end if;
  if advance_ded<>0 then insert into public.payroll_components(organization_id,payroll_item_id,component_type,amount,currency,description) values(p.organization_id,item_id,'advance',-advance_ded,comp.currency,'Approved salary advances'); end if;
 end loop;
 update public.payroll_periods set status='calculated' where id=p.id;
 perform app_private.write_audit(p.organization_id,'GENERATE','payroll_run',run_id::text,null,jsonb_build_object('period_id',p.id,'generation',gen),null,null);
 return run_id;
end;$function$;

select app_private.write_audit(
  o.id,
  'MARK_ATTENDANCE_TEST_PERIOD',
  'attendance_test_period',
  '2026-08-01:2026-08-04',
  null,
  jsonb_build_object('starts_on','2026-08-01','ends_on','2026-08-04','payroll_effect','excluded','discipline_effect','excluded'),
  'Owner designated the first four days of August 2026 as test-only attendance records.',
  null
)
from public.organizations o
where o.code='ADSCOPE';
create or replace function public.review_attendance_day(
  p_day_id uuid,
  p_status_override public.attendance_status default null,
  p_notice_provided boolean default false,
  p_late_approval public.approval_status default 'none'::public.approval_status,
  p_overtime_approval public.approval_status default 'none'::public.approval_status,
  p_check_in_local timestamp without time zone default null,
  p_check_out_local timestamp without time zone default null,
  p_break_minutes integer default null,
  p_finalize_review boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  d public.attendance_days%rowtype;
  v_timezone text;
  v_final_in timestamptz;
  v_final_out timestamptz;
  v_final_break integer;
  v_status public.attendance_status;
  v_old jsonb;
begin
  if not app_private.has_any_role(array['owner']::public.app_role[]) then
    raise exception 'Only an Owner can review or finalize attendance corrections';
  end if;

  select * into d
  from public.attendance_days
  where id=p_day_id and organization_id=app_private.current_organization_id()
  for update;
  if not found then raise exception 'Attendance record not found'; end if;

  v_old := to_jsonb(d);
  select timezone into v_timezone from public.organizations where id=d.organization_id;
  if v_timezone is null then v_timezone:='Africa/Cairo'; end if;

  v_final_in := case when p_check_in_local is null then coalesce(d.finalized_check_in_at,d.check_in_at) else p_check_in_local at time zone v_timezone end;
  v_final_out := case when p_check_out_local is null then coalesce(d.finalized_check_out_at,d.check_out_at) else p_check_out_local at time zone v_timezone end;
  v_final_break := greatest(coalesce(p_break_minutes,d.finalized_break_minutes,d.break_minutes,0),0);
  v_status := p_status_override;

  if p_finalize_review then
    if v_status not in ('absent','leave','permission','holiday','weekend') and (v_final_in is null or v_final_out is null) then
      raise exception 'Enter the final check-in and check-out times, or choose a non-working attendance status.';
    end if;
    if v_final_in is not null and v_final_out is not null and v_final_out<=v_final_in then
      raise exception 'Final check-out must be later than final check-in.';
    end if;

    update public.attendance_days
    set status_override=v_status,
        notice_provided=p_notice_provided,
        late_approval=p_late_approval,
        overtime_approval=p_overtime_approval,
        manual_finalized=true,
        finalized_check_in_at=case when v_status in('absent','leave','permission','holiday','weekend') then null else v_final_in end,
        finalized_check_out_at=case when v_status in('absent','leave','permission','holiday','weekend') then null else v_final_out end,
        finalized_break_minutes=case when v_status in('absent','leave','permission','holiday','weekend') then 0 else v_final_break end,
        session_state='closed',
        requires_owner_review=false,
        excluded_from_totals=false,
        review_reason=null,
        review_finalized_at=now(),
        review_finalized_by=(select auth.uid()),
        source='owner_finalized_correction',
        notes=concat_ws(' · ',notes,nullif(trim(p_notes),'')),
        closed_at=coalesce(v_final_out,now()),
        updated_at=now()
    where id=d.id;
  else
    update public.attendance_days
    set status_override=v_status,
        notice_provided=p_notice_provided,
        late_approval=p_late_approval,
        overtime_approval=p_overtime_approval,
        notes=concat_ws(' · ',notes,nullif(trim(p_notes),'')),
        updated_at=now()
    where id=d.id;
  end if;

  perform app_private.recompute_attendance_day(d.id);

  perform app_private.write_audit(
    d.organization_id,
    case when p_finalize_review then 'ATTENDANCE_REVIEW_FINALIZED' else 'ATTENDANCE_REVIEW_UPDATED' end,
    'attendance_day',d.id::text,v_old,(select to_jsonb(x) from public.attendance_days x where x.id=d.id),
    case when p_finalize_review then 'Owner finalized attendance values while preserving raw employee events.' else 'Owner updated attendance review fields.' end,
    null
  );

  return (select to_jsonb(x) from public.attendance_days x where x.id=d.id);
end;
$function$;

revoke all on function public.review_attendance_day(uuid,public.attendance_status,boolean,public.approval_status,public.approval_status,timestamp without time zone,timestamp without time zone,integer,boolean,text) from public,anon;
grant execute on function public.review_attendance_day(uuid,public.attendance_status,boolean,public.approval_status,public.approval_status,timestamp without time zone,timestamp without time zone,integer,boolean,text) to authenticated;

-- Approved attendance-correction requests now write final values instead of overwriting raw event evidence.
create or replace function public.decide_permission_request(p_request_id uuid,p_approve boolean,p_notes text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  r public.permission_requests%rowtype;
  v_day uuid;
  v_status text;
  d public.attendance_days%rowtype;
  v_effective_in timestamptz;
  v_effective_out timestamptz;
begin
  if not app_private.has_any_role(array['owner']::public.app_role[]) then raise exception 'Only an Owner can approve or reject employee requests'; end if;
  select * into r from public.permission_requests where id=p_request_id and organization_id=app_private.current_organization_id() for update;
  if not found then raise exception 'Request not found'; end if;
  if r.status<>'pending' then raise exception 'Request is already decided'; end if;
  v_status:=case when p_approve then 'approved' else 'rejected' end;

  if p_approve then
    v_day:=app_private.ensure_attendance_day(r.employee_id,r.request_date);
    if r.request_type='late_start' then
      update public.attendance_days set scheduled_start=r.requested_start_time,notice_provided=true,late_approval='approved',notes=concat_ws(' · ',notes,'Approved late-start permission') where id=v_day;
    elsif r.request_type='early_leave' then
      update public.attendance_days set scheduled_end=r.requested_end_time,notice_provided=true,notes=concat_ws(' · ',notes,'Approved early-leave permission') where id=v_day;
    else
      select * into d from public.attendance_days where id=v_day for update;
      v_effective_in:=coalesce(r.corrected_check_in,d.finalized_check_in_at,d.check_in_at);
      v_effective_out:=coalesce(r.corrected_check_out,d.finalized_check_out_at,d.check_out_at);
      update public.attendance_days set
        manual_finalized=true,
        finalized_check_in_at=v_effective_in,
        finalized_check_out_at=v_effective_out,
        finalized_break_minutes=coalesce(finalized_break_minutes,break_minutes,0),
        status_override=null,
        requires_owner_review=not(v_effective_in is not null and v_effective_out is not null),
        excluded_from_totals=not(v_effective_in is not null and v_effective_out is not null),
        session_state=case when v_effective_in is not null and v_effective_out is not null then 'closed' else 'needs_review' end,
        review_reason=case when v_effective_in is not null and v_effective_out is not null then null else 'Approved correction is still missing a final check-in or check-out time.' end,
        review_finalized_at=case when v_effective_in is not null and v_effective_out is not null then now() else review_finalized_at end,
        review_finalized_by=case when v_effective_in is not null and v_effective_out is not null then (select auth.uid()) else review_finalized_by end,
        source='approved_correction',
        notes=concat_ws(' · ',notes,'Approved attendance correction'),
        closed_at=case when v_effective_in is not null and v_effective_out is not null then v_effective_out else closed_at end,
        updated_at=now()
      where id=v_day;
      perform app_private.recompute_attendance_day(v_day);
    end if;
  end if;

  update public.permission_requests
  set status=v_status,decided_by=(select auth.uid()),decided_at=now(),decision_notes=p_notes,attendance_day_id=coalesce(v_day,attendance_day_id),updated_at=now()
  where id=r.id;

  perform app_private.notify_employee(r.employee_id,'request_decision','Request '||v_status,'Your '||replace(r.request_type,'_',' ')||' request for '||r.request_date||' was '||v_status||'.','permission_request',r.id);
end;
$function$;

create or replace function public.get_monthly_hours_summary(p_month_start date)
returns table(employee_id uuid,employee_code text,employee_name text,required_minutes integer,full_month_required_minutes integer,worked_minutes integer,balance_minutes integer,recorded_overtime_minutes integer,approved_overtime_minutes integer)
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  v_org uuid:=app_private.current_organization_id();
  v_month_start date:=date_trunc('month',p_month_start)::date;
  v_month_end date:=(date_trunc('month',p_month_start)+interval '1 month - 1 day')::date;
  v_today date;
  v_cutoff date;
begin
  if v_org is null then raise exception 'Organization context is required'; end if;
  if not app_private.has_any_role(array['owner','hr_admin','payroll_manager','manager','viewer']::public.app_role[]) then raise exception 'Not authorized'; end if;
  v_today:=app_private.organization_local_date(v_org,clock_timestamp());
  v_cutoff:=least(v_month_end,v_today);

  return query
  with eligible_employees as(
    select e.id,e.employee_code::text as code,e.full_name
    from public.employees e
    where e.organization_id=v_org and e.attendance_required and e.status='active'
      and(e.hire_date is null or e.hire_date<=v_month_end)
      and(e.termination_date is null or e.termination_date>=v_month_start)
  ),
  daily as(
    select ad.employee_id,ad.attendance_date,ad.is_test_record,ad.scheduled_workday,ad.excluded_from_totals,
      coalesce(ad.status_override,ad.status) as effective_status,
      case when ad.excluded_from_totals then 0 else greatest(coalesce(ad.worked_minutes,0),0) end as actual_minutes,
      case when ad.excluded_from_totals then 0 else greatest(coalesce(ad.overtime_minutes,0),0) end as overtime_recorded,
      case when ad.excluded_from_totals then 0 else greatest(coalesce(ad.approved_overtime_minutes,0),0) end as overtime_approved,
      case
        when ad.is_test_record or ad.excluded_from_totals or not ad.scheduled_workday then 0
        when coalesce(ad.status_override,ad.status) in('leave','holiday','weekend') then 0
        else least(
          greatest(round(coalesce(ad.required_hours,0)*60)::integer,0),
          case when ad.scheduled_start is null or ad.scheduled_end is null then greatest(round(coalesce(ad.required_hours,0)*60)::integer,0)
          else greatest(round(extract(epoch from((ad.attendance_date::timestamp+ad.scheduled_end+case when ad.scheduled_end<=ad.scheduled_start then interval '1 day' else interval '0 day' end)-(ad.attendance_date::timestamp+ad.scheduled_start)))/60)::integer-greatest(coalesce(ad.scheduled_break_minutes,0),0),0)
          end
        )
      end as target_minutes
    from public.attendance_days ad
    where ad.organization_id=v_org and ad.attendance_date between v_month_start and v_month_end
  )
  select e.id,e.code,e.full_name,
    coalesce(sum(d.target_minutes)filter(where d.attendance_date<=v_cutoff),0)::integer,
    coalesce(sum(d.target_minutes),0)::integer,
    coalesce(sum(d.actual_minutes)filter(where d.attendance_date<=v_cutoff and not d.is_test_record),0)::integer,
    (coalesce(sum(d.actual_minutes)filter(where d.attendance_date<=v_cutoff and not d.is_test_record),0)-coalesce(sum(d.target_minutes)filter(where d.attendance_date<=v_cutoff),0))::integer,
    coalesce(sum(d.overtime_recorded)filter(where d.attendance_date<=v_cutoff and not d.is_test_record),0)::integer,
    coalesce(sum(d.overtime_approved)filter(where d.attendance_date<=v_cutoff and not d.is_test_record),0)::integer
  from eligible_employees e
  left join daily d on d.employee_id=e.id
  group by e.id,e.code,e.full_name
  order by e.code;
end;
$function$;

create or replace function public.payroll_preflight(p_period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  p public.payroll_periods%rowtype;
  blockers jsonb:='[]'::jsonb;
  warnings jsonb:='[]'::jsonb;
  r record;
begin
  if not app_private.has_any_role(array['owner','hr_admin','payroll_manager']::public.app_role[]) then raise exception 'Not authorized'; end if;
  select * into p from public.payroll_periods where id=p_period_id and organization_id=app_private.current_organization_id();
  if not found then raise exception 'Payroll period not found'; end if;

  for r in select e.id,e.employee_code,e.full_name,e.hire_date,e.basic_salary,e.compensation_type,e.attendance_required,e.current_shift_id,e.payroll_currency
    from public.employees e where e.organization_id=p.organization_id and e.status='active' and(e.hire_date is null or e.hire_date<=p.month_end) and(e.termination_date is null or e.termination_date>=p.month_start)
  loop
    select c.compensation_type,c.basic_salary,c.attendance_required,c.currency into r.compensation_type,r.basic_salary,r.attendance_required,r.payroll_currency
    from app_private.compensation_for_date_or_current(r.id,greatest(p.month_start,coalesce(r.hire_date,p.month_start)))c;
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

  for r in
    select e.employee_code,count(*) as unresolved
    from public.attendance_days ad join public.employees e on e.id=ad.employee_id
    where ad.payroll_period_id=p.id and e.status='active' and e.attendance_required and not ad.is_test_record
      and(ad.requires_owner_review or ad.session_state='needs_review' or ad.status in('not_started','incomplete','missing_checkout','invalid'))
    group by e.employee_code
    having count(*)>0
  loop blockers:=blockers||jsonb_build_array(r.employee_code||' has '||r.unresolved||' unresolved attendance day(s)'); end loop;

  if exists(select 1 from public.leave_requests where organization_id=p.organization_id and status in('draft','pending') and start_date<=p.month_end and end_date>=p.month_start) then blockers:=blockers||jsonb_build_array('Pending leave requests intersect this period'); end if;
  if exists(select 1 from public.commissions where organization_id=p.organization_id and status='pending' and payment_month=p.month_start) then blockers:=blockers||jsonb_build_array('Pending commissions exist for this period'); end if;
  if exists(select 1 from public.violations v where v.organization_id=p.organization_id and v.violation_date between p.month_start and p.month_end and(v.workflow_status in('notified','under_review') or v.appeal_status='pending') and not exists(select 1 from app_private.attendance_test_periods tp where tp.organization_id=v.organization_id and v.violation_date between tp.starts_on and tp.ends_on)) then blockers:=blockers||jsonb_build_array('Unresolved violations or appeals exist for this period'); end if;
  if not exists(select 1 from public.attendance_days where payroll_period_id=p.id and not is_test_record) then warnings:=warnings||jsonb_build_array('No non-test attendance days have been generated for this period'); end if;
  if exists(select 1 from public.attendance_days where payroll_period_id=p.id and is_test_record) then warnings:=warnings||jsonb_build_array('Test attendance records exist and are excluded from payroll and attendance closure'); end if;
  if exists(select 1 from public.attendance_days where payroll_period_id=p.id and system_issue and requires_owner_review) then warnings:=warnings||jsonb_build_array('System attendance issues are pending Owner correction and are excluded from hours until finalized'); end if;

  return jsonb_build_object('ok',jsonb_array_length(blockers)=0,'blockers',blockers,'warnings',warnings);
end;
$function$;

create or replace function public.close_attendance_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  p public.payroll_periods%rowtype;
  unresolved bigint;
begin
  if not app_private.has_any_role(array['owner','hr_admin']::public.app_role[]) then raise exception 'Not authorized'; end if;
  select * into p from public.payroll_periods where id=p_period_id and organization_id=app_private.current_organization_id() for update;
  if not found then raise exception 'Period not found'; end if;
  if p.status<>'open' then raise exception 'Attendance may only close from Open status'; end if;

  select count(*) into unresolved
  from public.attendance_days ad
  join public.employees e on e.id=ad.employee_id
  cross join lateral app_private.compensation_for_date_or_current(e.id,greatest(p.month_start,coalesce(e.hire_date,p.month_start)))c
  where ad.payroll_period_id=p.id and not ad.is_test_record and c.attendance_required and e.status='active' and ad.scheduled_workday
    and(ad.requires_owner_review or ad.session_state='needs_review' or ad.status in('not_started','incomplete','missing_checkout','invalid'));

  if unresolved>0 then raise exception '% unresolved attendance days remain',unresolved; end if;
  update public.payroll_periods set status='attendance_closed',attendance_closed_at=now(),attendance_closed_by=(select auth.uid()) where id=p.id;
  perform app_private.write_audit(p.organization_id,'CLOSE_ATTENDANCE','payroll_period',p.id::text,to_jsonb(p),jsonb_build_object('status','attendance_closed'),null,null);
end;
$function$;

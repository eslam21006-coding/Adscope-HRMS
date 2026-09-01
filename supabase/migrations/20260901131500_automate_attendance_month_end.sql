-- Routine employee attendance mistakes should not force Owners to manually clean
-- every row before payroll. Raw attendance evidence remains unchanged.
--
-- Policy defaults:
-- 1. Missed check-in: after the scheduled shift end + 24 hours, finalize the
--    attendance day as absence without notice for attendance/payroll purposes,
--    create only a draft discipline case, and let the employee correct/appeal.
-- 2. Missing checkout: after the attendance session hard-expiry, preserve the
--    missing raw checkout but cap payroll attendance at the scheduled shift end.
--    No automatic overtime is credited.
-- 3. System issues, ambiguous/invalid records, unusual extended checkouts and
--    employee-submitted pending requests remain real Owner-review exceptions.
-- 4. A current/future payroll month can never be closed early. Future scheduled
--    days are not reported as employee attendance failures.

alter table public.attendance_days
  add column if not exists auto_resolved boolean not null default false,
  add column if not exists auto_resolution_code text,
  add column if not exists auto_resolved_at timestamptz;

alter table public.attendance_days
  drop constraint if exists attendance_days_auto_resolution_code_check;
alter table public.attendance_days
  add constraint attendance_days_auto_resolution_code_check
  check (
    auto_resolution_code is null
    or auto_resolution_code in ('missed_check_in_absence','missing_checkout_scheduled_cap')
  );

create or replace function app_private.no_checkin_finalize_after(
  p_organization_id uuid,
  p_attendance_date date,
  p_scheduled_start time without time zone,
  p_scheduled_end time without time zone
)
returns timestamptz
language plpgsql
stable
security definer
set search_path to 'public','app_private'
as $function$
declare
  v_timezone text;
  v_shift_end timestamptz;
begin
  if p_scheduled_start is null or p_scheduled_end is null then return null; end if;

  select timezone into v_timezone
  from public.organizations
  where id=p_organization_id;
  if v_timezone is null then v_timezone:='Africa/Cairo'; end if;

  v_shift_end := (p_attendance_date::timestamp+p_scheduled_end) at time zone v_timezone;
  if p_scheduled_end<=p_scheduled_start then
    v_shift_end:=v_shift_end+interval '1 day';
  end if;
  return v_shift_end+interval '24 hours';
end;
$function$;

revoke all on function app_private.no_checkin_finalize_after(uuid,date,time without time zone,time without time zone)
  from public,anon,authenticated;

create or replace function app_private.auto_finalize_missed_checkin(
  p_day_id uuid,
  p_now timestamptz default clock_timestamp(),
  p_request_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public','app_private','extensions'
as $function$
declare
  d public.attendance_days%rowtype;
  e public.employees%rowtype;
  v_deadline timestamptz;
  v_type uuid;
  v_violation_id uuid;
  v_old jsonb;
begin
  select * into d from public.attendance_days where id=p_day_id for update;
  if not found then return false; end if;
  select * into e from public.employees where id=d.employee_id;
  if not found then return false; end if;

  if d.is_test_record
     or d.system_issue
     or not d.scheduled_workday
     or d.check_in_at is not null
     or coalesce(d.status_override,d.status) not in ('not_started','incomplete')
  then
    return false;
  end if;

  v_deadline:=app_private.no_checkin_finalize_after(
    d.organization_id,d.attendance_date,d.scheduled_start,d.scheduled_end
  );
  if v_deadline is null or p_now<v_deadline then return false; end if;

  -- Any pending request deserves human review instead of an automatic absence.
  if exists(
    select 1 from public.permission_requests pr
    where pr.employee_id=d.employee_id
      and pr.request_date=d.attendance_date
      and pr.status='pending'
  ) then return false; end if;

  if exists(
    select 1 from public.leave_requests lr
    where lr.employee_id=d.employee_id
      and lr.status in ('draft','pending','approved')
      and d.attendance_date between lr.start_date and lr.end_date
  ) then return false; end if;

  v_old:=to_jsonb(d);

  update public.attendance_days
  set status='absent',
      status_override='absent',
      session_state='closed',
      requires_owner_review=false,
      excluded_from_totals=false,
      worked_minutes=0,
      overtime_minutes=0,
      approved_overtime_minutes=0,
      deductible_late_minutes=0,
      auto_resolved=true,
      auto_resolution_code='missed_check_in_absence',
      auto_resolved_at=p_now,
      review_reason=null,
      closed_at=coalesce(closed_at,p_now),
      source='auto_missed_check_in_absence',
      notes=concat_ws(' · ',notes,'No check-in was recorded. After the 24-hour employee correction window, the day was finalized as absence without notice for attendance/payroll. Any disciplinary sanction still requires Owner review.'),
      updated_at=p_now
  where id=d.id;

  -- Create a draft incident only. This does not finalize a disciplinary sanction
  -- and does not block payroll merely because the employee forgot to check in.
  select id into v_type
  from public.violation_types
  where organization_id=d.organization_id
    and upper(code::text)='ABSENCE_NO_NOTICE'
    and is_active
  limit 1;

  if v_type is not null
     and not exists(
       select 1 from public.violations v
       where v.employee_id=d.employee_id
         and v.violation_date=d.attendance_date
         and v.violation_type_id=v_type
         and v.workflow_status<>'rejected'
     )
  then
    v_violation_id:=gen_random_uuid();
    insert into public.violations(
      id,organization_id,violation_code,employee_id,violation_type_id,
      violation_date,description,workflow_status,created_by
    ) values(
      v_violation_id,d.organization_id,
      ('ABS-'||to_char(d.attendance_date,'YYYYMMDD')||'-'||upper(substr(replace(v_violation_id::text,'-',''),1,5)))::citext,
      d.employee_id,v_type,d.attendance_date,
      'No check-in, approved leave, or pending correction was recorded before the 24-hour employee correction window expired.',
      'draft',(select auth.uid())
    );
  end if;

  perform app_private.notify_employee(
    d.employee_id,
    'attendance_auto_resolved',
    'Missed Check-In Finalized',
    format('No check-in was recorded for %s. The attendance day was finalized as absence without notice after the correction window expired. If you worked that day, submit an attendance correction. Any disciplinary decision remains subject to Owner review.',d.attendance_date),
    'attendance_day',d.id
  );

  perform app_private.write_audit(
    d.organization_id,'ATTENDANCE_AUTO_RESOLVED_MISSED_CHECKIN','attendance_day',d.id::text,
    v_old,(select to_jsonb(x) from public.attendance_days x where x.id=d.id),
    'Employee missed check-in and the 24-hour correction window expired. Attendance was finalized as absence without notice; discipline remains a separate Owner-reviewed workflow.',p_request_id
  );
  return true;
end;
$function$;

revoke all on function app_private.auto_finalize_missed_checkin(uuid,timestamptz,uuid)
  from public,anon,authenticated;

create or replace function app_private.auto_finalize_missing_checkout(
  p_day_id uuid,
  p_now timestamptz default clock_timestamp(),
  p_request_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  d public.attendance_days%rowtype;
  v_timezone text;
  v_cap timestamptz;
  v_break integer;
  v_expiry timestamptz;
  v_old jsonb;
begin
  select * into d from public.attendance_days where id=p_day_id for update;
  if not found then return false; end if;

  if d.is_test_record
     or d.system_issue
     or d.check_in_at is null
     or d.check_out_at is not null
     or d.scheduled_start is null
     or d.scheduled_end is null
  then
    return false;
  end if;

  v_expiry:=coalesce(
    d.session_expires_at,
    app_private.attendance_session_expiry(
      d.organization_id,d.attendance_date,d.scheduled_start,d.scheduled_end,d.check_in_at
    )
  );
  if v_expiry is null or p_now<v_expiry then return false; end if;

  select timezone into v_timezone from public.organizations where id=d.organization_id;
  if v_timezone is null then v_timezone:='Africa/Cairo'; end if;
  v_cap:=(d.attendance_date::timestamp+d.scheduled_end) at time zone v_timezone;
  if d.scheduled_end<=d.scheduled_start then v_cap:=v_cap+interval '1 day'; end if;

  -- If the employee checked in after the scheduled end, the default cap would
  -- create a zero/negative interval. That is genuinely ambiguous and must stay
  -- in Owner review instead of being guessed.
  if v_cap<=d.check_in_at then return false; end if;

  v_break:=greatest(coalesce(d.break_minutes,0),coalesce(d.scheduled_break_minutes,0));
  v_old:=to_jsonb(d);

  update public.attendance_days
  set manual_finalized=true,
      finalized_check_in_at=d.check_in_at,
      finalized_check_out_at=v_cap,
      finalized_break_minutes=v_break,
      session_state='closed',
      requires_owner_review=false,
      excluded_from_totals=false,
      status_override=null,
      review_reason=null,
      review_finalized_at=p_now,
      review_finalized_by=null,
      closed_at=coalesce(closed_at,p_now),
      auto_resolved=true,
      auto_resolution_code='missing_checkout_scheduled_cap',
      auto_resolved_at=p_now,
      source='auto_missing_checkout_scheduled_cap',
      notes=concat_ws(' · ',notes,'Raw checkout is missing. For attendance/payroll only, the shift was capped at the scheduled end and at least the scheduled break was deducted. No unverified overtime is credited. The employee may submit a correction.'),
      updated_at=p_now
  where id=d.id;

  perform app_private.recompute_attendance_day(d.id);

  perform app_private.notify_employee(
    d.employee_id,
    'attendance_auto_resolved',
    'Missing Checkout Finalized',
    format('Your checkout for %s was not recorded. For attendance/payroll, the shift was capped at the scheduled end with no unverified overtime. Raw attendance evidence remains unchanged. Submit an attendance correction if the actual checkout was different.',d.attendance_date),
    'attendance_day',d.id
  );

  perform app_private.write_audit(
    d.organization_id,'ATTENDANCE_AUTO_RESOLVED_MISSING_CHECKOUT','attendance_day',d.id::text,
    v_old,(select to_jsonb(x) from public.attendance_days x where x.id=d.id),
    'Employee checkout was missing after the hard session expiry. Raw events were preserved; payroll attendance was conservatively capped at scheduled shift end with no unverified overtime.',p_request_id
  );
  return true;
end;
$function$;

revoke all on function app_private.auto_finalize_missing_checkout(uuid,timestamptz,uuid)
  from public,anon,authenticated;

-- Portal state/actions call this function already. Replace the old behavior that
-- sent every ordinary missing checkout to Owner review with the default cap.
create or replace function app_private.expire_stale_attendance_sessions(
  p_employee_id uuid,
  p_now timestamptz default clock_timestamp(),
  p_request_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  r record;
  v_count integer:=0;
  v_today date;
  v_org uuid;
begin
  select organization_id into v_org from public.employees where id=p_employee_id;
  if v_org is null then return 0; end if;
  v_today:=app_private.organization_local_date(v_org,p_now);

  -- Resolve missed check-ins only after the employee's 24-hour correction window.
  for r in
    select ad.id
    from public.attendance_days ad
    where ad.employee_id=p_employee_id
      and ad.attendance_date<v_today
      and ad.scheduled_workday
      and not ad.is_test_record
      and not ad.system_issue
      and ad.check_in_at is null
      and coalesce(ad.status_override,ad.status) in ('not_started','incomplete')
    order by ad.attendance_date
  loop
    if app_private.auto_finalize_missed_checkin(r.id,p_now,p_request_id) then
      v_count:=v_count+1;
    end if;
  end loop;

  -- Resolve ordinary hard-expired missing checkouts. System issues and ambiguous
  -- records intentionally remain Owner-review exceptions.
  for r in
    select ad.id
    from public.attendance_days ad
    where ad.employee_id=p_employee_id
      and ad.check_in_at is not null
      and ad.check_out_at is null
      and not ad.is_test_record
      and not ad.system_issue
      and ad.session_state in ('open','needs_review')
    order by ad.attendance_date
  loop
    if app_private.auto_finalize_missing_checkout(r.id,p_now,p_request_id) then
      v_count:=v_count+1;
    end if;
  end loop;

  return v_count;
end;
$function$;

revoke all on function app_private.expire_stale_attendance_sessions(uuid,timestamptz,uuid)
  from public,anon,authenticated;

create or replace function app_private.apply_elapsed_attendance_defaults(
  p_period_id uuid,
  p_now timestamptz default clock_timestamp(),
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  p public.payroll_periods%rowtype;
  r record;
  v_today date;
  v_absences integer:=0;
  v_missing_checkouts integer:=0;
begin
  select * into p from public.payroll_periods where id=p_period_id;
  if not found then raise exception 'Payroll period not found'; end if;
  v_today:=app_private.organization_local_date(p.organization_id,p_now);

  for r in
    select ad.id
    from public.attendance_days ad
    join public.employees e on e.id=ad.employee_id
    where ad.payroll_period_id=p.id
      and e.status='active'
      and ad.attendance_date<v_today
      and ad.scheduled_workday
      and not ad.is_test_record
      and not ad.system_issue
      and ad.check_in_at is null
      and coalesce(ad.status_override,ad.status) in ('not_started','incomplete')
    order by ad.attendance_date,ad.employee_id
  loop
    if app_private.auto_finalize_missed_checkin(r.id,p_now,p_request_id) then
      v_absences:=v_absences+1;
    end if;
  end loop;

  for r in
    select ad.id
    from public.attendance_days ad
    join public.employees e on e.id=ad.employee_id
    where ad.payroll_period_id=p.id
      and e.status='active'
      and ad.attendance_date<v_today
      and ad.scheduled_workday
      and not ad.is_test_record
      and not ad.system_issue
      and ad.check_in_at is not null
      and ad.check_out_at is null
      and ad.session_state in ('open','needs_review')
    order by ad.attendance_date,ad.employee_id
  loop
    if app_private.auto_finalize_missing_checkout(r.id,p_now,p_request_id) then
      v_missing_checkouts:=v_missing_checkouts+1;
    end if;
  end loop;

  if v_absences>0 then
    perform app_private.notify_owners(
      p.organization_id,
      'attendance_auto_resolution_summary',
      'Attendance Defaults Applied',
      format('%s missed check-in day(s) were automatically finalized as absence without notice after the employee correction window expired. Draft discipline cases, where configured, remain available for later Owner review and do not block payroll attendance closure.',v_absences),
      'payroll_period',p.id
    );
  end if;

  return jsonb_build_object(
    'missed_checkins_finalized',v_absences,
    'missing_checkouts_capped',v_missing_checkouts,
    'total_auto_resolved',v_absences+v_missing_checkouts
  );
end;
$function$;

revoke all on function app_private.apply_elapsed_attendance_defaults(uuid,timestamptz,uuid)
  from public,anon,authenticated;

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
  v_today date;
  v_defaults jsonb;
  v_auto integer:=0;
begin
  if not app_private.has_any_role(array['owner','hr_admin','payroll_manager']::public.app_role[]) then
    raise exception 'Not authorized';
  end if;

  select * into p
  from public.payroll_periods
  where id=p_period_id and organization_id=app_private.current_organization_id();
  if not found then raise exception 'Payroll period not found'; end if;

  v_today:=app_private.organization_local_date(p.organization_id,clock_timestamp());
  v_defaults:=app_private.apply_elapsed_attendance_defaults(p.id,clock_timestamp(),null);
  v_auto:=coalesce((v_defaults->>'total_auto_resolved')::integer,0);

  if p.month_end>=v_today then
    blockers:=blockers||jsonb_build_array(
      format('Payroll month is still in progress. Attendance can be closed after %s.',p.month_end)
    );
  end if;

  for r in
    select e.id,e.employee_code,e.full_name,e.hire_date,e.basic_salary,e.compensation_type,
           e.attendance_required,e.current_shift_id,e.payroll_currency
    from public.employees e
    where e.organization_id=p.organization_id
      and e.status='active'
      and (e.hire_date is null or e.hire_date<=p.month_end)
      and (e.termination_date is null or e.termination_date>=p.month_start)
  loop
    select c.compensation_type,c.basic_salary,c.attendance_required,c.currency
    into r.compensation_type,r.basic_salary,r.attendance_required,r.payroll_currency
    from app_private.compensation_for_date_or_current(
      r.id,greatest(p.month_start,coalesce(r.hire_date,p.month_start))
    ) c;

    if r.compensation_type<>'commission_only' and r.basic_salary<=0 then
      blockers:=blockers||jsonb_build_array(r.employee_code||' has no valid base salary');
    end if;
    if r.attendance_required and r.current_shift_id is null then
      blockers:=blockers||jsonb_build_array(r.employee_code||' has no assigned shift');
    end if;
    if r.payroll_currency is null then
      blockers:=blockers||jsonb_build_array(r.employee_code||' has no payroll currency');
    end if;

    if exists(
      select 1 from public.commissions x where x.employee_id=r.id and x.payment_month=p.month_start and x.currency<>r.payroll_currency
      union all
      select 1 from public.payroll_adjustments x where x.employee_id=r.id and x.payment_month=p.month_start and x.currency<>r.payroll_currency
      union all
      select 1 from public.advances x where x.employee_id=r.id and x.deduction_month=p.month_start and x.currency<>r.payroll_currency
      union all
      select 1 from public.violations x where x.employee_id=r.id and x.violation_date between p.month_start and p.month_end and x.currency<>r.payroll_currency
    ) then
      blockers:=blockers||jsonb_build_array(r.employee_code||' has a financial record in a different currency from the period compensation profile');
    end if;

    if exists(
      select 1 from public.employee_compensation_history h
      where h.employee_id=r.id
        and h.effective_from between greatest(p.month_start,coalesce(r.hire_date,p.month_start))+1 and p.month_end
    ) then
      blockers:=blockers||jsonb_build_array(r.employee_code||' has a mid-period compensation change; move it to month start or use an approved adjustment');
    end if;

    if r.attendance_required and not exists(
      select 1 from public.attendance_days ad
      where ad.payroll_period_id=p.id
        and ad.employee_id=r.id
        and ad.scheduled_workday
        and not ad.is_test_record
    ) then
      blockers:=blockers||jsonb_build_array(r.employee_code||' has no generated non-test attendance schedule');
    end if;
  end loop;

  -- Future days are deliberately excluded here. A separate month-in-progress
  -- blocker prevents early closure without pretending future shifts are failures.
  for r in
    select e.employee_code,ad.attendance_date,ad.system_issue,ad.review_reason,
           ad.check_in_at,ad.check_out_at,ad.status,ad.session_state
    from public.attendance_days ad
    join public.employees e on e.id=ad.employee_id
    cross join lateral app_private.compensation_for_date_or_current(
      e.id,greatest(p.month_start,coalesce(e.hire_date,p.month_start))
    ) c
    where ad.payroll_period_id=p.id
      and e.status='active'
      and c.attendance_required
      and not ad.is_test_record
      and ad.scheduled_workday
      and ad.attendance_date<v_today
      and (
        ad.requires_owner_review
        or ad.session_state='needs_review'
        or ad.status in ('not_started','incomplete','missing_checkout','invalid')
      )
    order by ad.attendance_date,e.employee_code
  loop
    blockers:=blockers||jsonb_build_array(
      case
        when r.system_issue then format('%s — %s: system attendance issue requires Owner review',r.employee_code,r.attendance_date)
        when r.check_out_at is not null then format('%s — %s: unusual attendance record requires Owner review',r.employee_code,r.attendance_date)
        else format('%s — %s: attendance exception requires Owner review',r.employee_code,r.attendance_date)
      end
    );
  end loop;

  if exists(
    select 1 from public.permission_requests pr
    where pr.organization_id=p.organization_id
      and pr.status='pending'
      and pr.request_date between p.month_start and p.month_end
  ) then
    blockers:=blockers||jsonb_build_array('Pending attendance or permission requests require Owner decision for this period');
  end if;

  if exists(
    select 1 from public.leave_requests
    where organization_id=p.organization_id
      and status in ('draft','pending')
      and start_date<=p.month_end and end_date>=p.month_start
  ) then
    blockers:=blockers||jsonb_build_array('Pending leave requests intersect this period');
  end if;

  if exists(
    select 1 from public.commissions
    where organization_id=p.organization_id and status='pending' and payment_month=p.month_start
  ) then
    blockers:=blockers||jsonb_build_array('Pending commissions exist for this period');
  end if;

  if exists(
    select 1 from public.violations v
    where v.organization_id=p.organization_id
      and v.violation_date between p.month_start and p.month_end
      and (v.workflow_status in ('notified','under_review') or v.appeal_status='pending')
      and not exists(
        select 1 from app_private.attendance_test_periods tp
        where tp.organization_id=v.organization_id
          and v.violation_date between tp.starts_on and tp.ends_on
      )
  ) then
    blockers:=blockers||jsonb_build_array('Unresolved violations or appeals exist for this period');
  end if;

  if v_auto>0 then
    warnings:=warnings||jsonb_build_array(
      format('%s routine attendance exception(s) were automatically resolved using the company defaults: %s missed check-in absence(s), %s missing checkout scheduled-cap record(s).',
        v_auto,
        coalesce((v_defaults->>'missed_checkins_finalized')::integer,0),
        coalesce((v_defaults->>'missing_checkouts_capped')::integer,0)
      )
    );
  end if;

  if exists(select 1 from public.attendance_days where payroll_period_id=p.id and is_test_record) then
    warnings:=warnings||jsonb_build_array('Test attendance records exist and are excluded from payroll and attendance closure');
  end if;

  return jsonb_build_object(
    'ok',jsonb_array_length(blockers)=0,
    'blockers',blockers,
    'warnings',warnings,
    'auto_resolution',v_defaults
  );
end;
$function$;

revoke all on function public.payroll_preflight(uuid) from public,anon;
grant execute on function public.payroll_preflight(uuid) to authenticated;

create or replace function public.close_attendance_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  p public.payroll_periods%rowtype;
  v_today date;
  v_preflight jsonb;
  v_message text;
begin
  if not app_private.has_any_role(array['owner','hr_admin']::public.app_role[]) then
    raise exception 'Not authorized';
  end if;

  select * into p
  from public.payroll_periods
  where id=p_period_id and organization_id=app_private.current_organization_id()
  for update;
  if not found then raise exception 'Period not found'; end if;
  if p.status<>'open' then raise exception 'Attendance may only close from Open status'; end if;

  v_today:=app_private.organization_local_date(p.organization_id,clock_timestamp());
  if p.month_end>=v_today then
    raise exception 'Payroll month is still in progress. Attendance can be closed after %.',p.month_end;
  end if;

  v_preflight:=public.payroll_preflight(p.id);
  if not coalesce((v_preflight->>'ok')::boolean,false) then
    select string_agg(value,'; ')
    into v_message
    from jsonb_array_elements_text(v_preflight->'blockers');
    raise exception 'Payroll preflight failed: %',coalesce(v_message,'Resolve the remaining payroll blockers.');
  end if;

  update public.payroll_periods
  set status='attendance_closed',attendance_closed_at=now(),attendance_closed_by=(select auth.uid())
  where id=p.id;

  perform app_private.write_audit(
    p.organization_id,'CLOSE_ATTENDANCE','payroll_period',p.id::text,to_jsonb(p),
    jsonb_build_object('status','attendance_closed'),
    'Attendance closed after routine employee attendance mistakes were automatically resolved and only true review exceptions were cleared.',null
  );
end;
$function$;

revoke all on function public.close_attendance_period(uuid) from public,anon;
grant execute on function public.close_attendance_period(uuid) to authenticated;

-- EMPTEST is explicitly a test employee and must not participate in live payroll.
-- Keep the record/history; simply deactivate it instead of deleting anything.
do $block$
declare
  r public.employees%rowtype;
begin
  for r in
    select e.*
    from public.employees e
    join public.organizations o on o.id=e.organization_id
    where o.code='ADSCOPE'
      and upper(e.employee_code::text)='EMPTEST'
      and e.status='active'
    for update of e
  loop
    update public.employees
    set status='inactive',updated_at=now()
    where id=r.id;

    perform app_private.write_audit(
      r.organization_id,'DEACTIVATE_TEST_EMPLOYEE','employee',r.id::text,to_jsonb(r),
      (select to_jsonb(x) from public.employees x where x.id=r.id),
      'EMPTEST is a test record and was deactivated so it no longer blocks or participates in live payroll.',null
    );
  end loop;
end;
$block$;

-- Clean historical August routine exceptions immediately when this migration is
-- applied. System issues and genuine review cases are intentionally untouched.
do $block$
declare
  r record;
begin
  for r in
    select pp.id
    from public.payroll_periods pp
    join public.organizations o on o.id=pp.organization_id
    where o.code='ADSCOPE'
      and pp.month_start=date '2026-08-01'
      and pp.status='open'
  loop
    perform app_private.apply_elapsed_attendance_defaults(r.id,clock_timestamp(),null);
  end loop;
end;
$block$;

comment on function app_private.apply_elapsed_attendance_defaults(uuid,timestamptz,uuid) is
  'Applies non-disciplinary attendance defaults so routine missed check-ins and missing checkouts do not become Owner payroll-cleanup work. System issues and genuine exceptions remain reviewable.';

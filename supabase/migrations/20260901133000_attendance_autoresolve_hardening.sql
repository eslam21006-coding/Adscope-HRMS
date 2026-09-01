-- Hardening for routine attendance auto-resolution.
-- Keep the existing portal's expiry-count contract: the count means records
-- that were moved to Owner review, not records that the system safely resolved.

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
  v_owner_review_count integer:=0;
  v_today date;
  v_org uuid;
  v_expiry timestamptz;
  v_old jsonb;
begin
  select organization_id into v_org from public.employees where id=p_employee_id;
  if v_org is null then return 0; end if;
  v_today:=app_private.organization_local_date(v_org,p_now);

  -- Employee-caused missed check-ins are system-resolved after the correction
  -- window. They do not contribute to the Owner-review count returned here.
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
    perform app_private.auto_finalize_missed_checkin(r.id,p_now,p_request_id);
  end loop;

  -- Auto-cap an ordinary missing checkout. If it cannot be safely capped
  -- (system issue, no usable schedule, or check-in after the scheduled cap),
  -- expire the open session into Owner review so it never blocks the next day.
  for r in
    select ad.*
    from public.attendance_days ad
    where ad.employee_id=p_employee_id
      and ad.check_in_at is not null
      and ad.check_out_at is null
      and not ad.is_test_record
      and ad.session_state in ('open','needs_review')
    order by ad.attendance_date
    for update
  loop
    if app_private.auto_finalize_missing_checkout(r.id,p_now,p_request_id) then
      continue;
    end if;

    if r.session_state<>'open' then
      continue;
    end if;

    v_expiry:=coalesce(
      r.session_expires_at,
      app_private.attendance_session_expiry(
        r.organization_id,r.attendance_date,r.scheduled_start,r.scheduled_end,r.check_in_at
      )
    );
    if v_expiry is null or v_expiry>p_now then
      continue;
    end if;

    v_old:=to_jsonb(r);
    update public.attendance_days
    set session_state='needs_review',
        session_expires_at=v_expiry,
        requires_owner_review=true,
        excluded_from_totals=true,
        status_override='missing_checkout',
        status='missing_checkout',
        worked_minutes=0,
        overtime_minutes=0,
        approved_overtime_minutes=0,
        deductible_late_minutes=0,
        review_reason=coalesce(
          review_reason,
          case when r.system_issue
            then 'System attendance issue with a missing checkout requires Owner review.'
            else 'Missing checkout could not be safely resolved from the scheduled shift and requires Owner review.'
          end
        ),
        closed_at=coalesce(closed_at,p_now),
        updated_at=p_now
    where id=r.id;

    perform app_private.notify_owners(
      r.organization_id,
      'attendance_review_required',
      'Attendance Review Needed',
      format('%s has a missing checkout for %s that could not be safely resolved automatically. The old shift was closed for review and will not block a new workday.',
        (select full_name from public.employees where id=r.employee_id),r.attendance_date),
      'attendance_day',r.id
    );

    perform app_private.write_audit(
      r.organization_id,'ATTENDANCE_SESSION_EXPIRED_TO_OWNER_REVIEW','attendance_day',r.id::text,
      v_old,(select to_jsonb(x) from public.attendance_days x where x.id=r.id),
      'The missing checkout reached hard expiry but could not be safely capped at the scheduled shift end. The session was closed into Owner review without inventing a raw checkout.',p_request_id
    );
    v_owner_review_count:=v_owner_review_count+1;
  end loop;

  return v_owner_review_count;
end;
$function$;

revoke all on function app_private.expire_stale_attendance_sessions(uuid,timestamptz,uuid)
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
  v_now timestamptz:=clock_timestamp();
  v_defaults jsonb;
  v_new_auto integer:=0;
  v_auto_absences integer:=0;
  v_auto_caps integer:=0;
begin
  if not app_private.has_any_role(array['owner','hr_admin','payroll_manager']::public.app_role[]) then
    raise exception 'Not authorized';
  end if;

  select * into p
  from public.payroll_periods
  where id=p_period_id and organization_id=app_private.current_organization_id();
  if not found then raise exception 'Payroll period not found'; end if;

  v_today:=app_private.organization_local_date(p.organization_id,v_now);
  v_defaults:=app_private.apply_elapsed_attendance_defaults(p.id,v_now,null);
  v_new_auto:=coalesce((v_defaults->>'total_auto_resolved')::integer,0);

  select
    count(*) filter(where auto_resolution_code='missed_check_in_absence'),
    count(*) filter(where auto_resolution_code='missing_checkout_scheduled_cap')
  into v_auto_absences,v_auto_caps
  from public.attendance_days
  where payroll_period_id=p.id and auto_resolved;

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

  -- Only elapsed days can become attendance exceptions. Future days are handled
  -- exclusively by the month-in-progress guard above.
  for r in
    select e.employee_code,ad.attendance_date,ad.system_issue,ad.review_reason,
           ad.check_in_at,ad.check_out_at,ad.status,ad.session_state,
           app_private.no_checkin_finalize_after(
             ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end
           ) as no_checkin_deadline,
           coalesce(
             ad.session_expires_at,
             app_private.attendance_session_expiry(
               ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end,ad.check_in_at
             )
           ) as checkout_expiry
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
        when r.system_issue then
          format('%s — %s: system attendance issue requires Owner review',r.employee_code,r.attendance_date)
        when r.check_in_at is null
          and r.status in ('not_started','incomplete')
          and r.no_checkin_deadline is not null
          and r.no_checkin_deadline>v_now
        then
          format('%s — %s: employee correction window remains open until %s; no Owner action is required yet',r.employee_code,r.attendance_date,r.no_checkin_deadline)
        when r.check_in_at is not null
          and r.check_out_at is null
          and r.checkout_expiry is not null
          and r.checkout_expiry>v_now
        then
          format('%s — %s: checkout recovery window remains open until %s; no Owner action is required yet',r.employee_code,r.attendance_date,r.checkout_expiry)
        when r.check_out_at is not null then
          format('%s — %s: unusual attendance record requires Owner review',r.employee_code,r.attendance_date)
        else
          format('%s — %s: attendance exception requires Owner review',r.employee_code,r.attendance_date)
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

  if v_auto_absences+v_auto_caps>0 then
    warnings:=warnings||jsonb_build_array(
      format('%s routine attendance exception(s) in this payroll period were automatically resolved: %s missed check-in absence(s) and %s missing checkout scheduled-cap record(s). Raw attendance evidence is preserved.',
        v_auto_absences+v_auto_caps,v_auto_absences,v_auto_caps)
    );
  end if;

  if v_new_auto>0 then
    warnings:=warnings||jsonb_build_array(
      format('%s of those routine attendance exception(s) were resolved during this readiness check.',v_new_auto)
    );
  end if;

  if exists(select 1 from public.attendance_days where payroll_period_id=p.id and is_test_record) then
    warnings:=warnings||jsonb_build_array('Test attendance records exist and are excluded from payroll and attendance closure');
  end if;

  return jsonb_build_object(
    'ok',jsonb_array_length(blockers)=0,
    'blockers',blockers,
    'warnings',warnings,
    'auto_resolution',jsonb_build_object(
      'missed_checkins_finalized',v_auto_absences,
      'missing_checkouts_capped',v_auto_caps,
      'total_auto_resolved',v_auto_absences+v_auto_caps,
      'newly_resolved_this_check',v_new_auto
    )
  );
end;
$function$;

revoke all on function public.payroll_preflight(uuid) from public,anon;
grant execute on function public.payroll_preflight(uuid) to authenticated;

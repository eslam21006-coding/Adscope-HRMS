-- Adscope full-time Saturday schedule exception effective 2026-08-29.
-- Saturday is a scheduled workday for full-time Adscope employees from 12:00 to 21:00
-- with a 60-minute scheduled break (8 required working hours).
-- Early check-in remains allowed; lateness is measured from 12:00 using the
-- employee's existing shift grace period.

create or replace function app_private.ensure_attendance_day(p_employee uuid, p_date date)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare
  v_employee public.employees%rowtype;
  v_shift public.shifts%rowtype;
  v_period uuid;
  v_day uuid;
  v_workday boolean;
  v_is_holiday boolean;
  v_is_adscope boolean;
  v_is_full_time_saturday boolean;
  v_dow integer := extract(dow from p_date)::integer;
  v_scheduled_start time without time zone;
  v_scheduled_end time without time zone;
  v_scheduled_break_minutes integer;
  v_required_hours numeric;
begin
  select * into v_employee from public.employees where id = p_employee;
  if not found then raise exception 'Employee not found'; end if;
  if app_private.is_locked_period(v_employee.organization_id, p_date) then raise exception 'Payroll period is locked'; end if;

  select exists(
    select 1 from public.organizations o
    where o.id=v_employee.organization_id and o.code='ADSCOPE'
  ) into v_is_adscope;

  select id into v_period
  from public.payroll_periods
  where organization_id = v_employee.organization_id
    and p_date between month_start and month_end;

  if v_period is null then
    insert into public.payroll_periods(organization_id, month_start, month_end, status)
    values (
      v_employee.organization_id,
      date_trunc('month', p_date)::date,
      (date_trunc('month', p_date) + interval '1 month - 1 day')::date,
      'open'
    )
    on conflict (organization_id, month_start)
    do update set organization_id = excluded.organization_id
    returning id into v_period;
  end if;

  select * into v_shift
  from public.shifts
  where id = app_private.effective_shift(p_employee, p_date);
  if not found and v_employee.attendance_required then raise exception 'Employee has no effective shift'; end if;

  select exists (
    select 1
    from public.official_holidays h
    where h.organization_id = v_employee.organization_id
      and h.holiday_date = p_date
  ) into v_is_holiday;

  v_is_full_time_saturday := v_is_adscope
    and v_employee.employment_type = 'full_time'
    and p_date >= date '2026-08-29'
    and v_dow = 6;

  v_workday := v_shift.id is not null
    and not v_is_holiday
    and (v_is_full_time_saturday or v_dow = any(v_shift.workdays));

  v_scheduled_start := case
    when v_is_full_time_saturday then time '12:00:00'
    else v_shift.start_time
  end;
  v_scheduled_end := case
    when v_is_full_time_saturday then time '21:00:00'
    else v_shift.end_time
  end;
  v_scheduled_break_minutes := case
    when v_is_full_time_saturday then 60
    else v_shift.break_minutes
  end;
  v_required_hours := case
    when v_is_full_time_saturday then 8
    else v_shift.required_hours
  end;

  insert into public.attendance_days(
    organization_id, payroll_period_id, employee_id, attendance_date,
    scheduled_workday, shift_id, scheduled_start, scheduled_end,
    scheduled_break_minutes, required_hours, grace_minutes, status, source
  ) values (
    v_employee.organization_id, v_period, p_employee, p_date,
    v_workday, v_shift.id, v_scheduled_start, v_scheduled_end,
    v_scheduled_break_minutes, v_required_hours, v_shift.grace_minutes,
    case
      when v_workday then 'not_started'::public.attendance_status
      when v_is_holiday then 'holiday'::public.attendance_status
      else 'weekend'::public.attendance_status
    end,
    'generated'
  )
  on conflict (employee_id, attendance_date)
  do update set
    payroll_period_id = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.payroll_period_id else public.attendance_days.payroll_period_id end,
    scheduled_workday = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.scheduled_workday else public.attendance_days.scheduled_workday end,
    shift_id = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.shift_id else public.attendance_days.shift_id end,
    scheduled_start = case
      when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null
        and not exists (
          select 1 from public.permission_requests pr
          where pr.employee_id = public.attendance_days.employee_id
            and pr.request_date = public.attendance_days.attendance_date
            and pr.request_type = 'late_start'
            and pr.status = 'approved'
        )
      then excluded.scheduled_start
      else public.attendance_days.scheduled_start
    end,
    scheduled_end = case
      when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null
        and not exists (
          select 1 from public.permission_requests pr
          where pr.employee_id = public.attendance_days.employee_id
            and pr.request_date = public.attendance_days.attendance_date
            and pr.request_type = 'early_leave'
            and pr.status = 'approved'
        )
      then excluded.scheduled_end
      else public.attendance_days.scheduled_end
    end,
    scheduled_break_minutes = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.scheduled_break_minutes else public.attendance_days.scheduled_break_minutes end,
    required_hours = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.required_hours else public.attendance_days.required_hours end,
    grace_minutes = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.grace_minutes else public.attendance_days.grace_minutes end,
    status = case
      when public.attendance_days.check_in_at is null
        and public.attendance_days.check_out_at is null
        and not coalesce(public.attendance_days.requires_owner_review,false)
        and coalesce(public.attendance_days.status_override, public.attendance_days.status) = 'weekend'::public.attendance_status
      then excluded.status
      else public.attendance_days.status
    end
  returning id into v_day;

  if v_day is null then
    select id into v_day
    from public.attendance_days
    where employee_id = p_employee and attendance_date = p_date;
  end if;
  if v_day is null then raise exception 'Attendance day could not be prepared'; end if;
  return v_day;
end;
$function$;

comment on function app_private.ensure_attendance_day(uuid, date) is
  'Generates attendance days from the assigned shift, with an Adscope-only full-time Saturday exception from 2026-08-29 of 12:00-21:00, a 60-minute scheduled break and 8 required hours. Approved date-specific permissions are preserved.';

-- Correct already-generated Adscope Saturday rows from the effective date onward,
-- including an open/closed current-day session, while preserving raw events,
-- approved leave and approved date-specific schedule permissions.
update public.attendance_days ad
set
  scheduled_workday = true,
  scheduled_start = case
    when exists (
      select 1 from public.permission_requests pr
      where pr.employee_id = ad.employee_id
        and pr.request_date = ad.attendance_date
        and pr.request_type = 'late_start'
        and pr.status = 'approved'
    ) then ad.scheduled_start
    else time '12:00:00'
  end,
  scheduled_end = case
    when exists (
      select 1 from public.permission_requests pr
      where pr.employee_id = ad.employee_id
        and pr.request_date = ad.attendance_date
        and pr.request_type = 'early_leave'
        and pr.status = 'approved'
    ) then ad.scheduled_end
    else time '21:00:00'
  end,
  scheduled_break_minutes = 60,
  required_hours = 8,
  session_expires_at = case
    when ad.session_state = 'open' and ad.check_in_at is not null then
      app_private.attendance_session_expiry(
        ad.organization_id,
        ad.attendance_date,
        case
          when exists (
            select 1 from public.permission_requests pr
            where pr.employee_id = ad.employee_id
              and pr.request_date = ad.attendance_date
              and pr.request_type = 'late_start'
              and pr.status = 'approved'
          ) then ad.scheduled_start
          else time '12:00:00'
        end,
        case
          when exists (
            select 1 from public.permission_requests pr
            where pr.employee_id = ad.employee_id
              and pr.request_date = ad.attendance_date
              and pr.request_type = 'early_leave'
              and pr.status = 'approved'
          ) then ad.scheduled_end
          else time '21:00:00'
        end,
        ad.check_in_at
      )
    else ad.session_expires_at
  end,
  status = case
    when ad.check_in_at is null
      and ad.check_out_at is null
      and not coalesce(ad.requires_owner_review, false)
      and coalesce(ad.status_override, ad.status) = 'weekend'::public.attendance_status
    then 'not_started'::public.attendance_status
    else ad.status
  end,
  updated_at = now()
from public.employees e
join public.organizations o on o.id=e.organization_id and o.code='ADSCOPE'
where e.id = ad.employee_id
  and e.employment_type = 'full_time'
  and ad.attendance_date >= date '2026-08-29'
  and extract(dow from ad.attendance_date)::integer = 6
  and app_private.effective_shift(e.id, ad.attendance_date) is not null
  and not coalesce(ad.is_test_record, false)
  and not exists (
    select 1
    from public.official_holidays h
    where h.organization_id = ad.organization_id
      and h.holiday_date = ad.attendance_date
  );

-- Recalculate affected Adscope Saturday records from preserved attendance events
-- so late minutes, worked minutes and overtime use the new Saturday schedule.
do $block$
declare
  r record;
begin
  for r in
    select ad.id
    from public.attendance_days ad
    join public.employees e on e.id = ad.employee_id
    join public.organizations o on o.id=e.organization_id and o.code='ADSCOPE'
    where e.employment_type = 'full_time'
      and ad.attendance_date >= date '2026-08-29'
      and extract(dow from ad.attendance_date)::integer = 6
      and app_private.effective_shift(e.id, ad.attendance_date) is not null
      and not coalesce(ad.is_test_record, false)
      and not exists (
        select 1
        from public.official_holidays h
        where h.organization_id = ad.organization_id
          and h.holiday_date = ad.attendance_date
      )
  loop
    perform app_private.recompute_attendance_day(r.id);
  end loop;
end;
$block$;

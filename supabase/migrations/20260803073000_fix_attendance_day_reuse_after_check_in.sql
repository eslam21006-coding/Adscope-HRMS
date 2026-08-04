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
  v_dow integer := extract(dow from p_date)::integer;
begin
  select * into v_employee from public.employees where id = p_employee;
  if not found then raise exception 'Employee not found'; end if;
  if app_private.is_locked_period(v_employee.organization_id, p_date) then raise exception 'Payroll period is locked'; end if;

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

  v_workday := v_shift.id is not null
    and v_dow = any(v_shift.workdays)
    and not exists (
      select 1 from public.official_holidays h
      where h.organization_id = v_employee.organization_id
        and h.holiday_date = p_date
    );

  insert into public.attendance_days(
    organization_id, payroll_period_id, employee_id, attendance_date,
    scheduled_workday, shift_id, scheduled_start, scheduled_end,
    scheduled_break_minutes, required_hours, grace_minutes, status, source
  ) values (
    v_employee.organization_id, v_period, p_employee, p_date,
    v_workday, v_shift.id, v_shift.start_time, v_shift.end_time,
    v_shift.break_minutes, v_shift.required_hours, v_shift.grace_minutes,
    case
      when v_workday then 'not_started'::public.attendance_status
      when exists (
        select 1 from public.official_holidays h
        where h.organization_id = v_employee.organization_id
          and h.holiday_date = p_date
      ) then 'holiday'::public.attendance_status
      else 'weekend'::public.attendance_status
    end,
    'generated'
  )
  on conflict (employee_id, attendance_date)
  do update set
    payroll_period_id = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.payroll_period_id else public.attendance_days.payroll_period_id end,
    scheduled_workday = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.scheduled_workday else public.attendance_days.scheduled_workday end,
    shift_id = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.shift_id else public.attendance_days.shift_id end,
    scheduled_start = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.scheduled_start else public.attendance_days.scheduled_start end,
    scheduled_end = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.scheduled_end else public.attendance_days.scheduled_end end,
    scheduled_break_minutes = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.scheduled_break_minutes else public.attendance_days.scheduled_break_minutes end,
    required_hours = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.required_hours else public.attendance_days.required_hours end,
    grace_minutes = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.grace_minutes else public.attendance_days.grace_minutes end,
    status = case when public.attendance_days.check_in_at is null and public.attendance_days.check_out_at is null then excluded.status else public.attendance_days.status end
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
  'Returns an existing attendance day after check-in while preserving recorded attendance values.';

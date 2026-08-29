-- Keep every newly generated full-time Saturday attendance row aligned with
-- the company Saturday schedule, regardless of which attendance-generation
-- function created the row. This runs only on INSERT, so later Owner-approved
-- date-specific permissions can still adjust scheduled_start/scheduled_end.

create or replace function app_private.apply_full_time_saturday_schedule_on_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  v_is_full_time boolean := false;
  v_is_holiday boolean := false;
begin
  if new.attendance_date < date '2026-08-29'
     or extract(dow from new.attendance_date)::integer <> 6
  then
    return new;
  end if;

  select e.employment_type = 'full_time'
  into v_is_full_time
  from public.employees e
  where e.id = new.employee_id
    and e.organization_id = new.organization_id;

  if not coalesce(v_is_full_time,false) then
    return new;
  end if;

  select exists (
    select 1
    from public.official_holidays h
    where h.organization_id = new.organization_id
      and h.holiday_date = new.attendance_date
  ) into v_is_holiday;

  if v_is_holiday then
    return new;
  end if;

  new.scheduled_workday := true;
  new.scheduled_start := time '12:00:00';
  new.scheduled_end := time '21:00:00';
  new.scheduled_break_minutes := 60;
  new.required_hours := 8;

  if new.check_in_at is null
     and new.check_out_at is null
     and new.status = 'weekend'::public.attendance_status
  then
    new.status := 'not_started'::public.attendance_status;
  end if;

  return new;
end;
$function$;

drop trigger if exists attendance_days_full_time_saturday_schedule on public.attendance_days;
create trigger attendance_days_full_time_saturday_schedule
before insert on public.attendance_days
for each row
execute function app_private.apply_full_time_saturday_schedule_on_insert();

comment on function app_private.apply_full_time_saturday_schedule_on_insert() is
  'Normalizes newly inserted full-time Saturday attendance rows to 12:00-21:00 with a 60-minute break from 2026-08-29 onward; official holidays remain unchanged.';

create or replace function public.record_attendance_event(
  p_event_type public.attendance_event_type,
  p_idempotency_key uuid,
  p_user_agent text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare
  uid uuid := (select auth.uid());
  e public.employees%rowtype;
  today_date date;
  local_date date;
  open_date date;
  day_id uuid;
  existing_event public.attendance_events%rowtype;
  last_type public.attendance_event_type;
  new_event public.attendance_events%rowtype;
  implicit_break_event public.attendance_events%rowtype;
  day_row public.attendance_days%rowtype;
  stale_day record;
  stale_review_count integer := 0;
  allowed boolean := false;
  attendance_required_now boolean;
  event_ts timestamptz;
  late_warning_text text;
  review_warning_text text;
begin
  if uid is null then raise exception 'Authentication required'; end if;

  select emp.* into e
  from public.employees emp
  join public.organization_memberships m
    on m.user_id = uid
   and m.organization_id = emp.organization_id
   and m.is_active
  where emp.user_id = uid
    and emp.status = 'active'
    and emp.portal_enabled
  limit 1;

  if not found then raise exception 'Employee attendance portal access is disabled'; end if;

  select * into existing_event
  from public.attendance_events
  where employee_id = e.id
    and idempotency_key = p_idempotency_key;

  if found then
    select * into day_row
    from public.attendance_days
    where id = existing_event.attendance_day_id;

    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'event', to_jsonb(existing_event),
      'attendance_day', to_jsonb(day_row),
      'late_warning', null,
      'review_warning', null
    );
  end if;

  today_date := app_private.organization_local_date(e.organization_id, clock_timestamp());
  local_date := today_date;

  for stale_day in
    update public.attendance_days ad
       set status = 'missing_checkout',
           status_override = 'missing_checkout',
           worked_minutes = 0,
           overtime_minutes = 0,
           approved_overtime_minutes = 0,
           notes = concat_ws(' · ', ad.notes, 'Open shift exceeded one overnight rollover. Owner attendance review required.'),
           updated_at = now()
     where ad.employee_id = e.id
       and ad.check_in_at is not null
       and ad.check_out_at is null
       and ad.attendance_date < today_date - 1
       and not coalesce(ad.is_test_record, false)
       and coalesce(ad.status_override, ad.status) <> 'missing_checkout'
    returning ad.id, ad.attendance_date
  loop
    stale_review_count := stale_review_count + 1;

    perform app_private.notify_owners(
      e.organization_id,
      'attendance_review_required',
      'Attendance Review Needed',
      format('%s has a missing checkout from %s. Review the attendance record before its hours become final.', e.full_name, stale_day.attendance_date),
      'attendance_day',
      stale_day.id
    );

    perform app_private.write_audit(
      e.organization_id,
      'MISSING_CHECKOUT_REVIEW_REQUIRED',
      'attendance_day',
      stale_day.id::text,
      null,
      jsonb_build_object(
        'employee_id', e.id,
        'attendance_date', stale_day.attendance_date,
        'status', 'missing_checkout',
        'provisional_worked_minutes', 0,
        'provisional_overtime_minutes', 0
      ),
      'Open attendance session exceeded one overnight rollover and was moved to Owner review without inventing a checkout time.',
      p_idempotency_key
    );
  end loop;

  if stale_review_count > 0 then
    review_warning_text := case
      when stale_review_count = 1 then 'A previous missing checkout was moved to Owner review. Its hours will stay provisional until corrected.'
      else format('%s previous missing checkouts were moved to Owner review. Their hours will stay provisional until corrected.', stale_review_count)
    end;
  end if;

  if p_event_type = 'CHECK_IN' then
    select ad.attendance_date into open_date
    from public.attendance_days ad
    where ad.employee_id = e.id
      and ad.check_in_at is not null
      and ad.check_out_at is null
      and ad.attendance_date = today_date - 1
      and not coalesce(ad.is_test_record, false)
      and coalesce(ad.status_override, ad.status) <> 'missing_checkout'
    order by ad.attendance_date desc
    limit 1;

    if open_date is not null then
      raise exception 'You still have an open shift from %. Check out before starting a new shift.', to_char(open_date, 'YYYY-MM-DD');
    end if;
  else
    select ad.attendance_date into local_date
    from public.attendance_days ad
    where ad.employee_id = e.id
      and ad.check_in_at is not null
      and ad.check_out_at is null
      and ad.attendance_date between today_date - 1 and today_date
      and not coalesce(ad.is_test_record, false)
      and coalesce(ad.status_override, ad.status) <> 'missing_checkout'
    order by ad.attendance_date desc
    limit 1;

    local_date := coalesce(local_date, today_date);
  end if;

  select c.attendance_required into attendance_required_now
  from app_private.compensation_for_date_or_current(e.id, local_date) c;

  if not coalesce(attendance_required_now, false) then
    raise exception 'Attendance is not required for this employee';
  end if;

  perform pg_advisory_xact_lock(hashtext(e.id::text || ':' || local_date::text));
  day_id := app_private.ensure_attendance_day(e.id, local_date);

  select event_type into last_type
  from public.attendance_events
  where attendance_day_id = day_id
  order by occurred_at desc, id desc
  limit 1;

  allowed := case
    when last_type is null then p_event_type = 'CHECK_IN'
    when last_type in ('CHECK_IN', 'BREAK_END') then p_event_type in ('BREAK_START', 'CHECK_OUT')
    when last_type = 'BREAK_START' then p_event_type in ('BREAK_END', 'CHECK_OUT')
    when last_type = 'CHECK_OUT' then false
    else false
  end;

  if not allowed then
    raise exception 'Event % is not allowed after %', p_event_type, coalesce(last_type::text, 'NO_EVENT');
  end if;

  event_ts := clock_timestamp();

  if last_type = 'BREAK_START' and p_event_type = 'CHECK_OUT' then
    insert into public.attendance_events(
      organization_id, employee_id, attendance_day_id, event_type,
      occurred_at, attendance_date, idempotency_key, source, created_by, user_agent,
      metadata
    ) values (
      e.organization_id, e.id, day_id, 'BREAK_END',
      event_ts, local_date, gen_random_uuid(), 'employee_portal', uid, left(p_user_agent, 500),
      jsonb_build_object('automatic', true, 'reason', 'checkout_while_on_break')
    )
    returning * into implicit_break_event;

    perform app_private.write_audit(
      e.organization_id,
      'BREAK_END',
      'attendance_event',
      implicit_break_event.id::text,
      null,
      to_jsonb(implicit_break_event),
      'Break automatically ended when the employee checked out.',
      p_idempotency_key
    );
  end if;

  insert into public.attendance_events(
    organization_id, employee_id, attendance_day_id, event_type,
    occurred_at, attendance_date, idempotency_key, source, created_by, user_agent
  ) values (
    e.organization_id, e.id, day_id, p_event_type,
    event_ts, local_date, p_idempotency_key, 'employee_portal', uid, left(p_user_agent, 500)
  )
  returning * into new_event;

  perform app_private.recompute_attendance_day(day_id);

  select * into day_row
  from public.attendance_days
  where id = day_id;

  if p_event_type = 'CHECK_IN'
     and e.employment_type = 'full_time'
     and coalesce(day_row.scheduled_workday, false)
     and not coalesce(day_row.is_test_record, false)
     and coalesce(day_row.raw_late_minutes, 0) > coalesce(day_row.grace_minutes, 0)
     and coalesce(day_row.late_approval, 'none'::public.approval_status) <> 'approved'::public.approval_status
  then
    late_warning_text := format(
      'Late check-in warning: you checked in %s minutes after your scheduled start time.',
      day_row.raw_late_minutes
    );

    perform app_private.notify_employee(
      e.id,
      'late_check_in_warning',
      'Late Check-In',
      format(
        'You checked in %s minutes after your scheduled start time. Please make sure to check in on time for future shifts. This is an attendance warning, not a disciplinary warning.',
        day_row.raw_late_minutes
      ),
      'attendance_day',
      day_id
    );

    perform app_private.write_audit(
      e.organization_id,
      'LATE_CHECK_IN_WARNING',
      'attendance_day',
      day_id::text,
      null,
      jsonb_build_object(
        'employee_id', e.id,
        'attendance_date', day_row.attendance_date,
        'late_minutes', day_row.raw_late_minutes,
        'grace_minutes', day_row.grace_minutes,
        'notification_type', 'late_check_in_warning'
      ),
      'Automatic attendance warning for a late full-time check-in.',
      p_idempotency_key
    );
  end if;

  perform app_private.write_audit(
    e.organization_id,
    p_event_type::text,
    'attendance_event',
    new_event.id::text,
    null,
    to_jsonb(new_event),
    null,
    p_idempotency_key
  );

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'event', to_jsonb(new_event),
    'attendance_day', to_jsonb(day_row),
    'late_warning', late_warning_text,
    'review_warning', review_warning_text
  );
end;
$function$;

comment on function public.record_attendance_event(public.attendance_event_type, uuid, text) is
  'Records employee attendance events, carries one overnight shift across midnight, automatically ends an active break on checkout, moves older missing checkouts to Owner review with zero provisional hours, and notifies full-time employees when a check-in exceeds the allowed grace period.';

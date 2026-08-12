create or replace function public.record_attendance_event(
  p_event_type public.attendance_event_type,
  p_idempotency_key uuid,
  p_user_agent text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  uid uuid := (select auth.uid());
  e public.employees%rowtype;
  today_date date;
  local_date date;
  day_id uuid;
  existing_event public.attendance_events%rowtype;
  last_type public.attendance_event_type;
  new_event public.attendance_events%rowtype;
  implicit_break_event public.attendance_events%rowtype;
  day_row public.attendance_days%rowtype;
  open_day public.attendance_days%rowtype;
  allowed boolean := false;
  attendance_required_now boolean;
  event_ts timestamptz;
  late_warning_text text;
  review_warning_text text;
  expired_count integer := 0;
begin
  if uid is null then raise exception 'Authentication required'; end if;

  select emp.* into e
  from public.employees emp
  join public.organization_memberships m
    on m.user_id=uid
   and m.organization_id=emp.organization_id
   and m.is_active
  where emp.user_id=uid
    and emp.status='active'
    and emp.portal_enabled
  limit 1;

  if not found then raise exception 'Employee attendance portal access is disabled'; end if;

  select * into existing_event
  from public.attendance_events
  where employee_id=e.id and idempotency_key=p_idempotency_key;

  if found then
    select * into day_row from public.attendance_days where id=existing_event.attendance_day_id;
    return jsonb_build_object('ok',true,'idempotent',true,'event',to_jsonb(existing_event),'attendance_day',to_jsonb(day_row),'late_warning',null,'review_warning',null);
  end if;

  perform pg_advisory_xact_lock(hashtext(e.id::text||':attendance_session'));

  today_date := app_private.organization_local_date(e.organization_id,clock_timestamp());
  expired_count := app_private.expire_stale_attendance_sessions(e.id,clock_timestamp(),p_idempotency_key);
  if expired_count>0 then
    review_warning_text := case when expired_count=1
      then 'A previous missing checkout was moved to Owner review. It will not block today''s attendance.'
      else format('%s previous missing checkouts were moved to Owner review. They will not block today''s attendance.',expired_count)
    end;
  end if;

  select * into open_day
  from public.attendance_days
  where employee_id=e.id and session_state='open'
  order by attendance_date desc
  limit 1
  for update;

  if p_event_type='CHECK_IN' then
    if open_day.id is not null then
      raise exception 'You already have an active attendance shift from %. Refresh the portal to continue or check out that shift.',to_char(open_day.attendance_date,'YYYY-MM-DD');
    end if;

    local_date := today_date;
    select c.attendance_required into attendance_required_now
    from app_private.compensation_for_date_or_current(e.id,local_date)c;
    if not coalesce(attendance_required_now,false) then raise exception 'Attendance is not required for this employee'; end if;

    day_id := app_private.ensure_attendance_day(e.id,local_date);
    select * into day_row from public.attendance_days where id=day_id for update;

    if day_row.session_state='needs_review' or day_row.requires_owner_review then
      raise exception 'Today''s attendance record needs Owner review before another shift can be started.';
    end if;
    if day_row.session_state='closed' or day_row.check_out_at is not null then
      raise exception 'Today''s attendance is already complete.';
    end if;
  else
    if open_day.id is null then
      raise exception 'No active attendance shift was found. Refresh the portal. A previous attendance issue will not block a new Check In for today.';
    end if;
    day_id := open_day.id;
    local_date := open_day.attendance_date;
    day_row := open_day;

    select c.attendance_required into attendance_required_now
    from app_private.compensation_for_date_or_current(e.id,local_date)c;
    if not coalesce(attendance_required_now,false) then raise exception 'Attendance is not required for this employee'; end if;
  end if;

  select event_type into last_type
  from public.attendance_events
  where attendance_day_id=day_id
  order by occurred_at desc,id desc
  limit 1;

  allowed := case
    when last_type is null then p_event_type='CHECK_IN'
    when last_type in('CHECK_IN','BREAK_END') then p_event_type in('BREAK_START','CHECK_OUT')
    when last_type='BREAK_START' then p_event_type in('BREAK_END','CHECK_OUT')
    when last_type='CHECK_OUT' then false
    else false
  end;

  if not allowed then
    raise exception 'This attendance action is not available in the current shift state. Refresh the portal and try again.';
  end if;

  event_ts := clock_timestamp();

  if last_type='BREAK_START' and p_event_type='CHECK_OUT' then
    insert into public.attendance_events(
      organization_id,employee_id,attendance_day_id,event_type,occurred_at,attendance_date,idempotency_key,source,created_by,user_agent,metadata
    ) values(
      e.organization_id,e.id,day_id,'BREAK_END',event_ts,local_date,gen_random_uuid(),'employee_portal',uid,left(p_user_agent,500),jsonb_build_object('automatic',true,'reason','checkout_while_on_break')
    ) returning * into implicit_break_event;

    perform app_private.write_audit(e.organization_id,'BREAK_END','attendance_event',implicit_break_event.id::text,null,to_jsonb(implicit_break_event),'Break automatically ended when the employee checked out.',p_idempotency_key);
  end if;

  insert into public.attendance_events(
    organization_id,employee_id,attendance_day_id,event_type,occurred_at,attendance_date,idempotency_key,source,created_by,user_agent
  ) values(
    e.organization_id,e.id,day_id,p_event_type,event_ts,local_date,p_idempotency_key,'employee_portal',uid,left(p_user_agent,500)
  ) returning * into new_event;

  if p_event_type='CHECK_IN' then
    update public.attendance_days
    set session_state='open',
        requires_owner_review=false,
        excluded_from_totals=false,
        review_reason=null,
        manual_finalized=false,
        review_finalized_at=null,
        review_finalized_by=null,
        closed_at=null,
        updated_at=now()
    where id=day_id;
  end if;

  perform app_private.recompute_attendance_day(day_id);

  if p_event_type='CHECK_IN' then
    update public.attendance_days ad
    set session_expires_at=app_private.attendance_session_expiry(ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end,ad.check_in_at),updated_at=now()
    where ad.id=day_id;
  elsif p_event_type='CHECK_OUT' then
    update public.attendance_days
    set session_state='closed',closed_at=event_ts,updated_at=now()
    where id=day_id;

    select * into day_row from public.attendance_days where id=day_id;
    if app_private.attendance_session_review_after(day_row.organization_id,day_row.attendance_date,day_row.scheduled_start,day_row.scheduled_end,day_row.check_in_at) is not null
       and event_ts > app_private.attendance_session_review_after(day_row.organization_id,day_row.attendance_date,day_row.scheduled_start,day_row.scheduled_end,day_row.check_in_at)
    then
      update public.attendance_days
      set session_state='needs_review',requires_owner_review=true,excluded_from_totals=true,
          review_reason='Extended checkout: checkout was recorded beyond the normal shift-end plus six-hour window. Confirm the extended shift before finalizing.',
          updated_at=now()
      where id=day_id;
      perform app_private.recompute_attendance_day(day_id);
      perform app_private.notify_owners(e.organization_id,'attendance_review_required','Extended Shift Review Needed',format('%s checked out after the normal extended-shift window for %s. Raw checkout was preserved and totals are paused until Owner review.',e.full_name,local_date),'attendance_day',day_id);
      review_warning_text:=concat_ws(' ',review_warning_text,'Your checkout was recorded, but this unusually long shift needs Owner review before its hours become final.');
    end if;
  end if;

  select * into day_row from public.attendance_days where id=day_id;

  if p_event_type='CHECK_IN'
     and e.employment_type='full_time'
     and coalesce(day_row.scheduled_workday,false)
     and not coalesce(day_row.is_test_record,false)
     and coalesce(day_row.raw_late_minutes,0)>coalesce(day_row.grace_minutes,0)
     and coalesce(day_row.late_approval,'none'::public.approval_status)<>'approved'::public.approval_status
  then
    late_warning_text := format('Late check-in warning: you checked in %s minutes after your scheduled start time.',day_row.raw_late_minutes);
    perform app_private.notify_employee(
      e.id,'late_check_in_warning','Late Check-In',
      format('You checked in %s minutes after your scheduled start time. Please make sure to check in on time for future shifts. This is an attendance warning, not a disciplinary warning.',day_row.raw_late_minutes),
      'attendance_day',day_id
    );
    perform app_private.write_audit(
      e.organization_id,'LATE_CHECK_IN_WARNING','attendance_day',day_id::text,null,
      jsonb_build_object('employee_id',e.id,'attendance_date',day_row.attendance_date,'late_minutes',day_row.raw_late_minutes,'grace_minutes',day_row.grace_minutes,'notification_type','late_check_in_warning'),
      'Automatic attendance warning for a late full-time check-in.',p_idempotency_key
    );
  end if;

  perform app_private.write_audit(e.organization_id,p_event_type::text,'attendance_event',new_event.id::text,null,to_jsonb(new_event),null,p_idempotency_key);

  return jsonb_build_object('ok',true,'idempotent',false,'event',to_jsonb(new_event),'attendance_day',to_jsonb(day_row),'late_warning',late_warning_text,'review_warning',review_warning_text);
end;
$function$;

comment on function public.record_attendance_event(public.attendance_event_type,uuid,text) is
  'Records attendance against one explicit open session. Checkout after shift end plus six hours is preserved and moved to Owner review; an open session hard-expires eighteen hours after check-in.';

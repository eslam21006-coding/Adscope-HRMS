-- Attendance session lifecycle hardening.
-- Sessions belong to a shift date, survive midnight only inside a bounded window,
-- and unresolved/system-error records are excluded from totals until finalized.

alter table public.attendance_days
  add column if not exists session_state text not null default 'not_started',
  add column if not exists session_expires_at timestamptz,
  add column if not exists requires_owner_review boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists system_issue boolean not null default false,
  add column if not exists excluded_from_totals boolean not null default false,
  add column if not exists manual_finalized boolean not null default false,
  add column if not exists finalized_check_in_at timestamptz,
  add column if not exists finalized_check_out_at timestamptz,
  add column if not exists finalized_break_minutes integer,
  add column if not exists review_finalized_at timestamptz,
  add column if not exists review_finalized_by uuid references auth.users(id) on delete set null;

alter table public.attendance_days
  drop constraint if exists attendance_days_session_state_check;
alter table public.attendance_days
  add constraint attendance_days_session_state_check
  check (session_state in ('not_started','open','closed','needs_review'));

alter table public.attendance_days
  drop constraint if exists attendance_days_finalized_break_minutes_check;
alter table public.attendance_days
  add constraint attendance_days_finalized_break_minutes_check
  check (finalized_break_minutes is null or finalized_break_minutes >= 0);

create or replace function app_private.attendance_session_expiry(
  p_organization_id uuid,
  p_attendance_date date,
  p_scheduled_start time without time zone,
  p_scheduled_end time without time zone,
  p_check_in_at timestamptz
)
returns timestamptz
language plpgsql
stable
security definer
set search_path to 'public','app_private'
as $function$
declare
  v_timezone text;
  v_scheduled_cap timestamptz;
  v_hard_cap timestamptz;
begin
  if p_check_in_at is null then return null; end if;

  v_hard_cap := p_check_in_at + interval '18 hours';

  if p_scheduled_start is null or p_scheduled_end is null then
    return v_hard_cap;
  end if;

  select timezone into v_timezone
  from public.organizations
  where id = p_organization_id;

  if v_timezone is null then v_timezone := 'Africa/Cairo'; end if;

  v_scheduled_cap := (p_attendance_date::timestamp + p_scheduled_end) at time zone v_timezone;
  if p_scheduled_end <= p_scheduled_start then
    v_scheduled_cap := v_scheduled_cap + interval '1 day';
  end if;
  v_scheduled_cap := v_scheduled_cap + interval '6 hours';

  return least(v_scheduled_cap, v_hard_cap);
end;
$function$;

-- Backfill explicit lifecycle state before enforcing one-open-session protection.
update public.attendance_days ad
set
  session_state = case
    when coalesce(ad.status_override,ad.status) in ('missing_checkout','invalid') then 'needs_review'
    when ad.check_in_at is null then 'not_started'
    when ad.check_out_at is not null then 'closed'
    else 'open'
  end,
  session_expires_at = case
    when ad.check_in_at is null then null
    else app_private.attendance_session_expiry(ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end,ad.check_in_at)
  end,
  requires_owner_review = coalesce(ad.status_override,ad.status) in ('missing_checkout','invalid'),
  excluded_from_totals = coalesce(ad.status_override,ad.status) in ('missing_checkout','invalid'),
  closed_at = case
    when ad.check_out_at is not null then coalesce(ad.closed_at,ad.check_out_at)
    when coalesce(ad.status_override,ad.status) in ('missing_checkout','invalid') then coalesce(ad.closed_at,ad.updated_at,now())
    else ad.closed_at
  end;

-- Any already-recorded checkout beyond the new bounded session window needs review.
update public.attendance_days ad
set
  session_state = 'needs_review',
  requires_owner_review = true,
  excluded_from_totals = true,
  status_override = 'invalid',
  status = 'invalid',
  worked_minutes = 0,
  overtime_minutes = 0,
  approved_overtime_minutes = 0,
  deductible_late_minutes = 0,
  review_reason = coalesce(ad.review_reason,'Recorded checkout occurred after the allowed attendance-session window. Verify the actual times before finalizing.'),
  closed_at = coalesce(ad.closed_at,ad.check_out_at,now())
where ad.check_in_at is not null
  and ad.check_out_at is not null
  and ad.session_expires_at is not null
  and ad.check_out_at > ad.session_expires_at
  and not coalesce(ad.is_test_record,false);

-- Expired open sessions must stop being active immediately.
update public.attendance_days ad
set
  session_state = 'needs_review',
  requires_owner_review = true,
  excluded_from_totals = true,
  status_override = 'missing_checkout',
  status = 'missing_checkout',
  worked_minutes = 0,
  overtime_minutes = 0,
  approved_overtime_minutes = 0,
  deductible_late_minutes = 0,
  review_reason = coalesce(ad.review_reason,'Missing checkout: the attendance session exceeded its allowed window and needs Owner review.'),
  closed_at = coalesce(ad.closed_at,now())
where ad.session_state = 'open'
  and ad.session_expires_at is not null
  and ad.session_expires_at <= clock_timestamp()
  and not coalesce(ad.is_test_record,false);

-- If legacy data somehow left more than one unexpired open session, keep only the newest.
with ranked as (
  select id,row_number() over(partition by employee_id order by attendance_date desc,check_in_at desc nulls last,id desc) as rn
  from public.attendance_days
  where session_state='open'
)
update public.attendance_days ad
set
  session_state='needs_review',
  requires_owner_review=true,
  excluded_from_totals=true,
  status_override='missing_checkout',
  status='missing_checkout',
  worked_minutes=0,
  overtime_minutes=0,
  approved_overtime_minutes=0,
  deductible_late_minutes=0,
  review_reason=coalesce(ad.review_reason,'Multiple legacy open sessions were detected. Owner review is required.'),
  closed_at=coalesce(ad.closed_at,now())
from ranked r
where ad.id=r.id and r.rn>1;

create unique index if not exists attendance_days_one_open_session_per_employee_idx
  on public.attendance_days(employee_id)
  where session_state='open';

-- Preserve raw events but allow Owner-finalized values to become the effective attendance values.
create or replace function app_private.recompute_attendance_day(p_day uuid)
returns void
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  d public.attendance_days%rowtype;
  first_in timestamptz;
  last_out timestamptz;
  total_break integer := 0;
  open_break timestamptz;
  ev record;
  shift_start_ts timestamptz;
  shift_end_ts timestamptz;
  work_min integer := 0;
  late_min integer := 0;
  ot_min integer := 0;
  effective_status public.attendance_status;
begin
  select * into d from public.attendance_days where id=p_day for update;
  if not found then raise exception 'Attendance day not found'; end if;

  if d.manual_finalized then
    first_in := d.finalized_check_in_at;
    last_out := d.finalized_check_out_at;
    total_break := greatest(coalesce(d.finalized_break_minutes,0),0);
  else
    for ev in
      select event_type,occurred_at
      from public.attendance_events
      where attendance_day_id=p_day
      order by occurred_at,id
    loop
      if ev.event_type='CHECK_IN' and first_in is null then first_in=ev.occurred_at; end if;
      if ev.event_type='BREAK_START' and open_break is null then open_break=ev.occurred_at; end if;
      if ev.event_type='BREAK_END' and open_break is not null then
        total_break := total_break + greatest(0,round(extract(epoch from (ev.occurred_at-open_break))/60)::integer);
        open_break := null;
      end if;
      if ev.event_type='CHECK_OUT' then last_out=ev.occurred_at; end if;
    end loop;
  end if;

  if first_in is not null and last_out is not null then
    work_min := greatest(0,round(extract(epoch from (last_out-first_in))/60)::integer-total_break);
  end if;

  if d.scheduled_start is not null and first_in is not null then
    shift_start_ts := (d.attendance_date::timestamp+d.scheduled_start) at time zone
      (select timezone from public.organizations where id=d.organization_id);
    late_min := greatest(0,round(extract(epoch from (first_in-shift_start_ts))/60)::integer);
  end if;

  if d.scheduled_end is not null and last_out is not null then
    shift_end_ts := (d.attendance_date::timestamp+d.scheduled_end) at time zone
      (select timezone from public.organizations where id=d.organization_id);
    if d.scheduled_end <= d.scheduled_start then shift_end_ts := shift_end_ts+interval '1 day'; end if;
    ot_min := greatest(0,round(extract(epoch from (last_out-shift_end_ts))/60)::integer);
  end if;

  effective_status := case
    when d.status_override is not null then d.status_override
    when d.requires_owner_review then 'missing_checkout'::public.attendance_status
    when first_in is null then case when d.scheduled_workday then 'not_started'::public.attendance_status else d.status end
    when last_out is null then 'incomplete'::public.attendance_status
    when work_min <= 0 then 'invalid'::public.attendance_status
    when late_min > d.grace_minutes then 'late'::public.attendance_status
    else 'present'::public.attendance_status
  end;

  update public.attendance_days set
    check_in_at=first_in,
    check_out_at=last_out,
    break_minutes=total_break,
    worked_minutes=case when excluded_from_totals then 0 else work_min end,
    raw_late_minutes=late_min,
    deductible_late_minutes=case when excluded_from_totals or notice_provided or late_approval='approved' then 0 else late_min end,
    overtime_minutes=case when excluded_from_totals then 0 else ot_min end,
    approved_overtime_minutes=case when excluded_from_totals then 0 when overtime_approval='approved' then ot_min else 0 end,
    status=effective_status,
    updated_at=now()
  where id=p_day;
end;
$function$;

create or replace function app_private.expire_stale_attendance_sessions(
  p_employee_id uuid,
  p_now timestamptz default clock_timestamp(),
  p_request_id uuid default null::uuid
)
returns integer
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  r record;
  v_count integer := 0;
  v_expiry timestamptz;
begin
  for r in
    select ad.*,e.full_name
    from public.attendance_days ad
    join public.employees e on e.id=ad.employee_id
    where ad.employee_id=p_employee_id
      and ad.session_state='open'
    order by ad.attendance_date
    for update of ad
  loop
    v_expiry := coalesce(r.session_expires_at,app_private.attendance_session_expiry(r.organization_id,r.attendance_date,r.scheduled_start,r.scheduled_end,r.check_in_at));
    if v_expiry is not null and v_expiry <= p_now then
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
          review_reason='Missing checkout: this shift passed the allowed checkout window. Submit a correction if the recorded times are incomplete.',
          closed_at=coalesce(closed_at,p_now),
          updated_at=now()
      where id=r.id;

      perform app_private.notify_owners(
        r.organization_id,
        'attendance_review_required',
        'Attendance Review Needed',
        format('%s has a missing checkout for %s. The old shift was closed for review and will not block a new workday.',r.full_name,r.attendance_date),
        'attendance_day',
        r.id
      );

      perform app_private.write_audit(
        r.organization_id,
        'ATTENDANCE_SESSION_EXPIRED',
        'attendance_day',
        r.id::text,
        jsonb_build_object('session_state','open','attendance_date',r.attendance_date,'session_expires_at',v_expiry),
        jsonb_build_object('session_state','needs_review','excluded_from_totals',true,'requires_owner_review',true),
        'Attendance session exceeded the bounded session window and was moved to Owner review without inventing a checkout time.',
        p_request_id
      );
      v_count := v_count+1;
    end if;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.get_my_attendance_state()
returns jsonb
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  uid uuid := (select auth.uid());
  e public.employees%rowtype;
  d public.attendance_days%rowtype;
  s public.shifts%rowtype;
  v_today date;
  v_last_type public.attendance_event_type;
  v_state text := 'not-in';
  v_actions jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_previous_review jsonb;
  v_expired integer := 0;
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

  v_today := app_private.organization_local_date(e.organization_id,clock_timestamp());
  v_expired := app_private.expire_stale_attendance_sessions(e.id,clock_timestamp(),null);

  select * into d
  from public.attendance_days
  where employee_id=e.id and session_state='open'
  order by attendance_date desc
  limit 1;

  if not found then
    select * into d
    from public.attendance_days
    where employee_id=e.id and attendance_date=v_today
    limit 1;
  end if;

  if d.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'event_type',x.event_type,
      'occurred_at',x.occurred_at,
      'attendance_date',x.attendance_date,
      'source',x.source
    ) order by x.occurred_at,x.id),'[]'::jsonb)
    into v_events
    from public.attendance_events x
    where x.attendance_day_id=d.id;

    select event_type into v_last_type
    from public.attendance_events
    where attendance_day_id=d.id
    order by occurred_at desc,id desc
    limit 1;

    if d.session_state='open' then
      if v_last_type='BREAK_START' then
        v_state := 'break';
        v_actions := '["BREAK_END","CHECK_OUT"]'::jsonb;
      else
        v_state := 'working';
        v_actions := '["BREAK_START","CHECK_OUT"]'::jsonb;
      end if;
    elsif d.session_state='closed' and d.attendance_date=v_today then
      v_state := 'done';
      v_actions := '[]'::jsonb;
    elsif d.session_state='needs_review' and d.attendance_date=v_today then
      v_state := 'needs-review';
      v_actions := '[]'::jsonb;
    else
      v_state := 'not-in';
      v_actions := '["CHECK_IN"]'::jsonb;
    end if;
  else
    v_actions := '["CHECK_IN"]'::jsonb;
  end if;

  select * into s
  from public.shifts
  where id=coalesce(d.shift_id,e.current_shift_id);

  select jsonb_build_object(
    'attendance_day_id',ad.id,
    'attendance_date',ad.attendance_date,
    'system_issue',ad.system_issue,
    'reason',ad.review_reason,
    'status',coalesce(ad.status_override,ad.status)
  )
  into v_previous_review
  from public.attendance_days ad
  where ad.employee_id=e.id
    and ad.requires_owner_review
    and ad.attendance_date < v_today
  order by ad.attendance_date desc
  limit 1;

  return jsonb_build_object(
    'employee_id',e.id,
    'attendance_required',e.attendance_required,
    'state',case when e.attendance_required then v_state else 'exempt' end,
    'allowed_actions',case when e.attendance_required then v_actions else '[]'::jsonb end,
    'shift_date',coalesce(d.attendance_date,v_today),
    'attendance_day_id',d.id,
    'session_state',d.session_state,
    'session_expires_at',d.session_expires_at,
    'requires_owner_review',coalesce(d.requires_owner_review,false),
    'system_issue',coalesce(d.system_issue,false),
    'review_reason',d.review_reason,
    'events',v_events,
    'shift',case when s.id is null then null else jsonb_build_object(
      'id',s.id,'name',s.name,'start_time',s.start_time,'end_time',s.end_time,
      'break_minutes',s.break_minutes,'required_hours',s.required_hours,'grace_minutes',s.grace_minutes
    ) end,
    'previous_review',v_previous_review,
    'expired_sessions_moved_to_review',v_expired
  );
end;
$function$;

revoke all on function public.get_my_attendance_state() from public,anon;
grant execute on function public.get_my_attendance_state() to authenticated;

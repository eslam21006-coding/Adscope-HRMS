-- Attendance is driven by an explicit server-owned session, not by the browser calendar date.
-- A session belongs to its shift date. It may cross midnight, but it hard-expires 18 hours after check-in.
-- A checkout later than scheduled shift end + 6 hours is preserved as raw evidence and requires Owner review.
-- Review/system-issue records are excluded from totals until an Owner finalizes them.

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

alter table public.attendance_days drop constraint if exists attendance_days_session_state_check;
alter table public.attendance_days add constraint attendance_days_session_state_check
  check (session_state in ('not_started','open','closed','needs_review'));

alter table public.attendance_days drop constraint if exists attendance_days_finalized_break_minutes_check;
alter table public.attendance_days add constraint attendance_days_finalized_break_minutes_check
  check (finalized_break_minutes is null or finalized_break_minutes >= 0);

create unique index if not exists attendance_days_one_open_session_per_employee_idx
  on public.attendance_days(employee_id) where session_state='open';

create or replace function app_private.attendance_session_expiry(
  p_organization_id uuid,p_attendance_date date,p_scheduled_start time without time zone,
  p_scheduled_end time without time zone,p_check_in_at timestamptz
) returns timestamptz language sql stable security definer
set search_path to 'public','app_private' as $function$
  select case when p_check_in_at is null then null else p_check_in_at + interval '18 hours' end;
$function$;

create or replace function app_private.attendance_session_review_after(
  p_organization_id uuid,p_attendance_date date,p_scheduled_start time without time zone,
  p_scheduled_end time without time zone,p_check_in_at timestamptz
) returns timestamptz language plpgsql stable security definer
set search_path to 'public','app_private' as $function$
declare v_timezone text; v_review_after timestamptz;
begin
  if p_check_in_at is null or p_scheduled_start is null or p_scheduled_end is null then return null; end if;
  select timezone into v_timezone from public.organizations where id=p_organization_id;
  if v_timezone is null then v_timezone:='Africa/Cairo'; end if;
  v_review_after := (p_attendance_date::timestamp+p_scheduled_end) at time zone v_timezone;
  if p_scheduled_end<=p_scheduled_start then v_review_after:=v_review_after+interval '1 day'; end if;
  return v_review_after+interval '6 hours';
end;
$function$;

create or replace function app_private.expire_stale_attendance_sessions(
  p_employee_id uuid,p_now timestamptz default clock_timestamp(),p_request_id uuid default null::uuid
) returns integer language plpgsql security definer
set search_path to 'public','app_private' as $function$
declare r record; v_count integer:=0; v_expiry timestamptz;
begin
  for r in
    select ad.*,e.full_name
    from public.attendance_days ad join public.employees e on e.id=ad.employee_id
    where ad.employee_id=p_employee_id and ad.session_state='open'
    order by ad.attendance_date for update of ad
  loop
    v_expiry:=coalesce(r.session_expires_at,app_private.attendance_session_expiry(r.organization_id,r.attendance_date,r.scheduled_start,r.scheduled_end,r.check_in_at));
    if v_expiry is not null and v_expiry<=p_now then
      update public.attendance_days set
        session_state='needs_review',session_expires_at=v_expiry,requires_owner_review=true,
        excluded_from_totals=true,status_override='missing_checkout',status='missing_checkout',
        worked_minutes=0,overtime_minutes=0,approved_overtime_minutes=0,deductible_late_minutes=0,
        review_reason='Missing checkout: this shift passed the allowed checkout window. Submit a correction if the recorded times are incomplete.',
        closed_at=coalesce(closed_at,p_now),updated_at=now()
      where id=r.id;
      perform app_private.notify_owners(r.organization_id,'attendance_review_required','Attendance Review Needed',
        format('%s has a missing checkout for %s. The old shift was closed for review and will not block a new workday.',r.full_name,r.attendance_date),
        'attendance_day',r.id);
      perform app_private.write_audit(r.organization_id,'ATTENDANCE_SESSION_EXPIRED','attendance_day',r.id::text,
        jsonb_build_object('session_state','open','attendance_date',r.attendance_date,'session_expires_at',v_expiry),
        jsonb_build_object('session_state','needs_review','excluded_from_totals',true,'requires_owner_review',true),
        'Attendance session exceeded the bounded session window and was moved to Owner review without inventing a checkout time.',p_request_id);
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.get_my_attendance_state()
returns jsonb language plpgsql security definer
set search_path to 'public','app_private' as $function$
declare
  uid uuid:=(select auth.uid()); e public.employees%rowtype; d public.attendance_days%rowtype;
  s public.shifts%rowtype; v_today date; v_last_type public.attendance_event_type;
  v_state text:='not-in'; v_actions jsonb:='[]'::jsonb; v_events jsonb:='[]'::jsonb;
  v_previous_review jsonb; v_expired integer:=0;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select emp.* into e from public.employees emp
  join public.organization_memberships m on m.user_id=uid and m.organization_id=emp.organization_id and m.is_active
  where emp.user_id=uid and emp.status='active' and emp.portal_enabled limit 1;
  if not found then raise exception 'Employee attendance portal access is disabled'; end if;

  v_today:=app_private.organization_local_date(e.organization_id,clock_timestamp());
  v_expired:=app_private.expire_stale_attendance_sessions(e.id,clock_timestamp(),null);

  select * into d from public.attendance_days where employee_id=e.id and session_state='open'
  order by attendance_date desc limit 1;
  if not found then
    select * into d from public.attendance_days where employee_id=e.id and attendance_date=v_today limit 1;
  end if;

  if d.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('event_type',x.event_type,'occurred_at',x.occurred_at,
      'attendance_date',x.attendance_date,'source',x.source) order by x.occurred_at,x.id),'[]'::jsonb)
    into v_events from public.attendance_events x where x.attendance_day_id=d.id;
    select event_type into v_last_type from public.attendance_events where attendance_day_id=d.id
      order by occurred_at desc,id desc limit 1;
    if d.session_state='open' then
      if v_last_type='BREAK_START' then v_state:='break';v_actions:='["BREAK_END","CHECK_OUT"]'::jsonb;
      else v_state:='working';v_actions:='["BREAK_START","CHECK_OUT"]'::jsonb; end if;
    elsif d.session_state='closed' and d.attendance_date=v_today then v_state:='done';
    elsif d.session_state='needs_review' and d.attendance_date=v_today then v_state:='needs-review';
    else v_state:='not-in';v_actions:='["CHECK_IN"]'::jsonb; end if;
  else
    v_actions:='["CHECK_IN"]'::jsonb;
  end if;

  select * into s from public.shifts where id=coalesce(d.shift_id,e.current_shift_id);
  select jsonb_build_object('attendance_day_id',ad.id,'attendance_date',ad.attendance_date,
    'system_issue',ad.system_issue,'reason',ad.review_reason,'status',coalesce(ad.status_override,ad.status))
  into v_previous_review from public.attendance_days ad
  where ad.employee_id=e.id and ad.requires_owner_review and ad.attendance_date<v_today
  order by ad.attendance_date desc limit 1;

  return jsonb_build_object('employee_id',e.id,'attendance_required',e.attendance_required,
    'state',case when e.attendance_required then v_state else 'exempt' end,
    'allowed_actions',case when e.attendance_required then v_actions else '[]'::jsonb end,
    'shift_date',coalesce(d.attendance_date,v_today),'attendance_day_id',d.id,
    'session_state',d.session_state,'session_expires_at',d.session_expires_at,
    'requires_owner_review',coalesce(d.requires_owner_review,false),'system_issue',coalesce(d.system_issue,false),
    'review_reason',d.review_reason,'events',v_events,
    'shift',case when s.id is null then null else jsonb_build_object('id',s.id,'name',s.name,'start_time',s.start_time,
      'end_time',s.end_time,'break_minutes',s.break_minutes,'required_hours',s.required_hours,'grace_minutes',s.grace_minutes) end,
    'previous_review',v_previous_review,'expired_sessions_moved_to_review',v_expired);
end;
$function$;
revoke all on function public.get_my_attendance_state() from public,anon;
grant execute on function public.get_my_attendance_state() to authenticated;

-- record_attendance_event remains the only employee write path. It first expires a stale open session,
-- permits only one open session per employee, and attaches non-check-in actions only to that explicit open session.
-- The production definition is intentionally kept in the prior migration chain and is regression-tested against these invariants.

-- Preserve unusual extended checkouts as raw evidence.
-- Scheduled end + 6 hours is a soft review threshold; check-in + 18 hours is the hard session expiry.
create or replace function app_private.attendance_session_expiry(
  p_organization_id uuid,
  p_attendance_date date,
  p_scheduled_start time without time zone,
  p_scheduled_end time without time zone,
  p_check_in_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path to 'public','app_private'
as $function$
  select case when p_check_in_at is null then null else p_check_in_at + interval '18 hours' end;
$function$;

create or replace function app_private.attendance_session_review_after(
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
  v_review_after timestamptz;
begin
  if p_check_in_at is null or p_scheduled_start is null or p_scheduled_end is null then return null; end if;
  select timezone into v_timezone from public.organizations where id=p_organization_id;
  if v_timezone is null then v_timezone:='Africa/Cairo'; end if;
  v_review_after := (p_attendance_date::timestamp+p_scheduled_end) at time zone v_timezone;
  if p_scheduled_end<=p_scheduled_start then v_review_after:=v_review_after+interval '1 day'; end if;
  return v_review_after+interval '6 hours';
end;
$function$;

update public.attendance_days ad
set session_expires_at=app_private.attendance_session_expiry(ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end,ad.check_in_at),updated_at=now()
where ad.check_in_at is not null;

-- Records between the soft threshold and hard cap remain reviewable rather than being treated as lost checkouts.
update public.attendance_days ad
set review_reason='Extended checkout: the recorded checkout is beyond the normal shift-end plus six-hour window. Raw times are preserved; confirm the extended shift before finalizing.',updated_at=now()
where ad.check_in_at is not null
  and ad.check_out_at is not null
  and ad.check_out_at<=ad.check_in_at+interval '18 hours'
  and app_private.attendance_session_review_after(ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end,ad.check_in_at) is not null
  and ad.check_out_at>app_private.attendance_session_review_after(ad.organization_id,ad.attendance_date,ad.scheduled_start,ad.scheduled_end,ad.check_in_at)
  and ad.requires_owner_review
  and not ad.system_issue;

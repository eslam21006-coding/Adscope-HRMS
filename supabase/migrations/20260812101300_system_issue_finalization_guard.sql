-- Final guard: known system-issue records must never reuse corrupted raw timestamps when an Owner finalizes a correction.
create or replace function public.review_attendance_day(
  p_day_id uuid,
  p_status_override public.attendance_status default null,
  p_notice_provided boolean default false,
  p_late_approval public.approval_status default 'none'::public.approval_status,
  p_overtime_approval public.approval_status default 'none'::public.approval_status,
  p_check_in_local timestamp without time zone default null,
  p_check_out_local timestamp without time zone default null,
  p_break_minutes integer default null,
  p_finalize_review boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  d public.attendance_days%rowtype;
  v_timezone text;
  v_final_in timestamptz;
  v_final_out timestamptz;
  v_final_break integer;
  v_status public.attendance_status;
  v_old jsonb;
begin
  if not app_private.has_any_role(array['owner']::public.app_role[]) then
    raise exception 'Only an Owner can review or finalize attendance corrections';
  end if;

  select * into d
  from public.attendance_days
  where id=p_day_id and organization_id=app_private.current_organization_id()
  for update;
  if not found then raise exception 'Attendance record not found'; end if;

  v_old := to_jsonb(d);
  select timezone into v_timezone from public.organizations where id=d.organization_id;
  if v_timezone is null then v_timezone:='Africa/Cairo'; end if;

  v_final_in := case when p_check_in_local is not null then p_check_in_local at time zone v_timezone when d.system_issue then d.finalized_check_in_at else coalesce(d.finalized_check_in_at,d.check_in_at) end;
  v_final_out := case when p_check_out_local is not null then p_check_out_local at time zone v_timezone when d.system_issue then d.finalized_check_out_at else coalesce(d.finalized_check_out_at,d.check_out_at) end;
  v_final_break := greatest(coalesce(p_break_minutes,d.finalized_break_minutes,d.break_minutes,0),0);
  v_status := p_status_override;

  if p_finalize_review then
    if (v_status is null or v_status not in ('absent','leave','permission','holiday','weekend')) and (v_final_in is null or v_final_out is null) then
      raise exception 'Enter the final check-in and check-out times, or choose a non-working attendance status.';
    end if;
    if v_final_in is not null and v_final_out is not null and v_final_out<=v_final_in then
      raise exception 'Final check-out must be later than final check-in.';
    end if;

    update public.attendance_days
    set status_override=v_status,
        notice_provided=p_notice_provided,
        late_approval=p_late_approval,
        overtime_approval=p_overtime_approval,
        manual_finalized=true,
        finalized_check_in_at=case when v_status in('absent','leave','permission','holiday','weekend') then null else v_final_in end,
        finalized_check_out_at=case when v_status in('absent','leave','permission','holiday','weekend') then null else v_final_out end,
        finalized_break_minutes=case when v_status in('absent','leave','permission','holiday','weekend') then 0 else v_final_break end,
        session_state='closed',
        requires_owner_review=false,
        excluded_from_totals=false,
        review_reason=null,
        review_finalized_at=now(),
        review_finalized_by=(select auth.uid()),
        source='owner_finalized_correction',
        notes=concat_ws(' · ',notes,nullif(trim(p_notes),'')),
        closed_at=coalesce(v_final_out,now()),
        updated_at=now()
    where id=d.id;
  else
    update public.attendance_days
    set status_override=v_status,
        notice_provided=p_notice_provided,
        late_approval=p_late_approval,
        overtime_approval=p_overtime_approval,
        notes=concat_ws(' · ',notes,nullif(trim(p_notes),'')),
        updated_at=now()
    where id=d.id;
  end if;

  perform app_private.recompute_attendance_day(d.id);

  perform app_private.write_audit(
    d.organization_id,
    case when p_finalize_review then 'ATTENDANCE_REVIEW_FINALIZED' else 'ATTENDANCE_REVIEW_UPDATED' end,
    'attendance_day',d.id::text,v_old,(select to_jsonb(x) from public.attendance_days x where x.id=d.id),
    case when p_finalize_review then 'Owner finalized attendance values while preserving raw employee events.' else 'Owner updated attendance review fields.' end,
    null
  );

  return (select to_jsonb(x) from public.attendance_days x where x.id=d.id);
end;
$function$;

revoke all on function public.review_attendance_day(uuid,public.attendance_status,boolean,public.approval_status,public.approval_status,timestamp without time zone,timestamp without time zone,integer,boolean,text) from public,anon;
grant execute on function public.review_attendance_day(uuid,public.attendance_status,boolean,public.approval_status,public.approval_status,timestamp without time zone,timestamp without time zone,integer,boolean,text) to authenticated;

-- Correct validation and system-issue fallback semantics for attendance correction.
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

  v_final_in := case when p_check_in_local is null then coalesce(d.finalized_check_in_at,d.check_in_at) else p_check_in_local at time zone v_timezone end;
  v_final_out := case when p_check_out_local is null then coalesce(d.finalized_check_out_at,d.check_out_at) else p_check_out_local at time zone v_timezone end;
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

-- Approved attendance-correction requests now write final values instead of overwriting raw event evidence.
create or replace function public.decide_permission_request(p_request_id uuid,p_approve boolean,p_notes text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  r public.permission_requests%rowtype;
  v_day uuid;
  v_status text;
  d public.attendance_days%rowtype;
  v_effective_in timestamptz;
  v_effective_out timestamptz;
begin
  if not app_private.has_any_role(array['owner']::public.app_role[]) then raise exception 'Only an Owner can approve or reject employee requests'; end if;
  select * into r from public.permission_requests where id=p_request_id and organization_id=app_private.current_organization_id() for update;
  if not found then raise exception 'Request not found'; end if;
  if r.status<>'pending' then raise exception 'Request is already decided'; end if;
  v_status:=case when p_approve then 'approved' else 'rejected' end;

  if p_approve then
    v_day:=app_private.ensure_attendance_day(r.employee_id,r.request_date);
    if r.request_type='late_start' then
      update public.attendance_days set scheduled_start=r.requested_start_time,notice_provided=true,late_approval='approved',notes=concat_ws(' · ',notes,'Approved late-start permission') where id=v_day;
    elsif r.request_type='early_leave' then
      update public.attendance_days set scheduled_end=r.requested_end_time,notice_provided=true,notes=concat_ws(' · ',notes,'Approved early-leave permission') where id=v_day;
    else
      select * into d from public.attendance_days where id=v_day for update;
      v_effective_in:=case when d.system_issue then coalesce(r.corrected_check_in,d.finalized_check_in_at) else coalesce(r.corrected_check_in,d.finalized_check_in_at,d.check_in_at) end;
      v_effective_out:=case when d.system_issue then coalesce(r.corrected_check_out,d.finalized_check_out_at) else coalesce(r.corrected_check_out,d.finalized_check_out_at,d.check_out_at) end;
      update public.attendance_days set
        manual_finalized=true,
        finalized_check_in_at=v_effective_in,
        finalized_check_out_at=v_effective_out,
        finalized_break_minutes=coalesce(finalized_break_minutes,break_minutes,0),
        status_override=null,
        requires_owner_review=not(v_effective_in is not null and v_effective_out is not null),
        excluded_from_totals=not(v_effective_in is not null and v_effective_out is not null),
        session_state=case when v_effective_in is not null and v_effective_out is not null then 'closed' else 'needs_review' end,
        review_reason=case when v_effective_in is not null and v_effective_out is not null then null else 'Approved correction is still missing a final check-in or check-out time.' end,
        review_finalized_at=case when v_effective_in is not null and v_effective_out is not null then now() else review_finalized_at end,
        review_finalized_by=case when v_effective_in is not null and v_effective_out is not null then (select auth.uid()) else review_finalized_by end,
        source='approved_correction',
        notes=concat_ws(' · ',notes,'Approved attendance correction'),
        closed_at=case when v_effective_in is not null and v_effective_out is not null then v_effective_out else closed_at end,
        updated_at=now()
      where id=v_day;
      perform app_private.recompute_attendance_day(v_day);
    end if;
  end if;

  update public.permission_requests
  set status=v_status,decided_by=(select auth.uid()),decided_at=now(),decision_notes=p_notes,attendance_day_id=coalesce(v_day,attendance_day_id),updated_at=now()
  where id=r.id;

  perform app_private.notify_employee(r.employee_id,'request_decision','Request '||v_status,'Your '||replace(r.request_type,'_',' ')||' request for '||r.request_date||' was '||v_status||'.','permission_request',r.id);
end;
$function$;

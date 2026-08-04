create or replace function public.flag_unauthorized_breaks(p_month_start date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'app_private', 'extensions'
as $function$
declare v_org uuid:=app_private.current_organization_id(); v_end date:=(p_month_start+interval '1 month - 1 day')::date; v_type uuid; v_tolerance int; r record; v_incidents int:=0; v_id uuid;
begin
 if not app_private.has_any_role(array['owner']::public.app_role[]) then raise exception 'Only an Owner can classify unauthorized breaks'; end if;
 select unauthorized_break_tolerance_minutes into v_tolerance from public.organization_settings where organization_id=v_org;
 select id into v_type from public.violation_types where organization_id=v_org and upper(code::text)='UNAUTH_BREAK' and is_active limit 1;
 if v_type is null then raise exception 'Unauthorized Break violation type is not configured'; end if;
 for r in
  select ad.id,ad.employee_id,ad.attendance_date,ad.break_minutes,ad.scheduled_break_minutes
  from public.attendance_days ad join public.employees e on e.id=ad.employee_id and e.organization_id=ad.organization_id
  where ad.organization_id=v_org and ad.attendance_date between p_month_start and least(v_end,current_date)
    and not ad.is_test_record and ad.scheduled_workday and e.status='active'
    and ad.break_minutes>ad.scheduled_break_minutes+coalesce(v_tolerance,10)
 loop
  if not exists(select 1 from public.violations v where v.employee_id=r.employee_id and v.violation_date=r.attendance_date and v.violation_type_id=v_type and v.workflow_status<>'rejected') then
    v_id:=gen_random_uuid();
    insert into public.violations(id,organization_id,violation_code,employee_id,violation_type_id,violation_date,description,workflow_status,created_by)
    values(v_id,v_org,('BRK-'||to_char(r.attendance_date,'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,5)))::citext,r.employee_id,v_type,r.attendance_date,'Recorded break time exceeded the scheduled break plus the configured tolerance. Actual break: '||r.break_minutes||' minutes; scheduled: '||r.scheduled_break_minutes||' minutes.','draft',(select auth.uid()));
    update public.attendance_days set notes=concat_ws(' · ',notes,'Unauthorized break threshold exceeded — Owner review required') where id=r.id;
    v_incidents:=v_incidents+1;
  end if;
 end loop;
 return jsonb_build_object('investigation_drafts_created',v_incidents,'tolerance_minutes',v_tolerance);
end $function$;

create or replace function public.flag_unexcused_absences(p_month_start date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'app_private', 'extensions'
as $function$
declare v_org uuid:=app_private.current_organization_id(); v_end date:=(p_month_start+interval '1 month - 1 day')::date; v_type uuid; r record; v_count int:=0; v_incidents int:=0; v_id uuid;
begin
 if not app_private.has_any_role(array['owner']::public.app_role[]) then raise exception 'Only an Owner can classify unexcused absences'; end if;
 select id into v_type from public.violation_types where organization_id=v_org and upper(code::text)='ABSENCE_NO_NOTICE' and is_active limit 1;
 if v_type is null then raise exception 'Absence Without Notice violation type is not configured'; end if;
 for r in
  select ad.id,ad.employee_id,ad.attendance_date,e.full_name
  from public.attendance_days ad join public.employees e on e.id=ad.employee_id and e.organization_id=ad.organization_id
  where ad.organization_id=v_org and ad.attendance_date between p_month_start and least(v_end,current_date-1)
    and not ad.is_test_record and ad.scheduled_workday and e.status='active' and e.attendance_required
    and ad.check_in_at is null and ad.status in('not_started','incomplete')
    and not exists(select 1 from public.leave_requests lr where lr.employee_id=ad.employee_id and lr.status in('pending','approved') and ad.attendance_date between lr.start_date and lr.end_date)
    and not exists(select 1 from public.permission_requests pr where pr.employee_id=ad.employee_id and pr.request_date=ad.attendance_date and pr.status in('pending','approved'))
  for update of ad
 loop
  update public.attendance_days set status='absent',status_override='absent',notice_provided=false,notes=concat_ws(' · ',notes,'Classified as absence without notice — Owner review required') where id=r.id;
  v_count:=v_count+1;
  if not exists(select 1 from public.violations v where v.employee_id=r.employee_id and v.violation_date=r.attendance_date and v.violation_type_id=v_type and v.workflow_status<>'rejected') then
    v_id:=gen_random_uuid();
    insert into public.violations(id,organization_id,violation_code,employee_id,violation_type_id,violation_date,description,workflow_status,created_by)
    values(v_id,v_org,('ABS-'||to_char(r.attendance_date,'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,5)))::citext,r.employee_id,v_type,r.attendance_date,'No attendance event, approved leave or approved permission was recorded for the scheduled workday.','draft',(select auth.uid()));
    v_incidents:=v_incidents+1;
  end if;
 end loop;
 return jsonb_build_object('attendance_days_classified',v_count,'investigation_drafts_created',v_incidents);
end $function$;
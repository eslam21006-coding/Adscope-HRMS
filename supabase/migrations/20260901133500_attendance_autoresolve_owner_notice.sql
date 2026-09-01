-- Absence without notice must still be visible to Owners even though routine
-- attendance cleanup no longer blocks payroll. This is informational: the
-- attendance result is already finalized, while any disciplinary decision
-- remains a separate draft workflow.

create or replace function app_private.notify_owners_on_auto_absence()
returns trigger
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
declare
  v_name text;
begin
  if new.auto_resolution_code='missed_check_in_absence'
     and new.auto_resolution_code is distinct from old.auto_resolution_code
  then
    select full_name into v_name from public.employees where id=new.employee_id;

    perform app_private.notify_owners(
      new.organization_id,
      'attendance_auto_resolved',
      'Absence Without Notice Auto-Resolved',
      format('%s had no check-in for %s after the employee correction window expired. Attendance was finalized as absence without notice so payroll is not blocked. No payroll action is required; any disciplinary decision remains a separate Owner-reviewed draft.',coalesce(v_name,'Employee'),new.attendance_date),
      'attendance_day',new.id
    );
  end if;

  return new;
end;
$function$;

revoke all on function app_private.notify_owners_on_auto_absence()
  from public,anon,authenticated;

drop trigger if exists attendance_days_auto_absence_owner_notice on public.attendance_days;
create trigger attendance_days_auto_absence_owner_notice
after update of auto_resolution_code on public.attendance_days
for each row
execute function app_private.notify_owners_on_auto_absence();

comment on function app_private.notify_owners_on_auto_absence() is
  'Creates an informational Owner notification when a missed check-in is auto-finalized as absence without notice. Payroll remains unblocked; discipline remains separate and Owner-reviewed.';

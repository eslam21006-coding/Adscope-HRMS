-- Owner-finalized attendance corrections with complete final times must not keep
-- a technical unresolved status such as missing_checkout. Keeping that override
-- causes payroll readiness to report already-finalized rows as unresolved and
-- also makes payroll attendance summaries misclassify the day.

create or replace function app_private.normalize_finalized_attendance_override()
returns trigger
language plpgsql
security definer
set search_path to 'public','app_private'
as $function$
begin
  if new.manual_finalized
     and not coalesce(new.requires_owner_review,false)
     and new.finalized_check_in_at is not null
     and new.finalized_check_out_at is not null
     and new.status_override in ('not_started','incomplete','missing_checkout','invalid')
  then
    new.status_override:=null;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.normalize_finalized_attendance_override()
  from public,anon,authenticated;

drop trigger if exists attendance_days_normalize_finalized_override on public.attendance_days;
create trigger attendance_days_normalize_finalized_override
before insert or update of manual_finalized,finalized_check_in_at,finalized_check_out_at,status_override,requires_owner_review
on public.attendance_days
for each row
execute function app_private.normalize_finalized_attendance_override();

comment on function app_private.normalize_finalized_attendance_override() is
  'Clears technical unresolved status overrides when an attendance correction has been finalized with complete times, allowing the normal attendance status to be recomputed.';

-- Repair previously finalized corrections that were left with a technical
-- unresolved override. Raw employee attendance events and finalized timestamps
-- are preserved; only the stale override is removed and the derived status is
-- recalculated.
do $block$
declare
  r record;
  v_old jsonb;
begin
  for r in
    select ad.id,ad.organization_id
    from public.attendance_days ad
    where ad.manual_finalized
      and not coalesce(ad.requires_owner_review,false)
      and ad.finalized_check_in_at is not null
      and ad.finalized_check_out_at is not null
      and ad.status_override in ('not_started','incomplete','missing_checkout','invalid')
    for update
  loop
    select to_jsonb(ad) into v_old from public.attendance_days ad where ad.id=r.id;

    update public.attendance_days
    set status_override=null,updated_at=now()
    where id=r.id;

    perform app_private.recompute_attendance_day(r.id);

    perform app_private.write_audit(
      r.organization_id,
      'ATTENDANCE_FINALIZED_STATUS_NORMALIZED',
      'attendance_day',
      r.id::text,
      v_old,
      (select to_jsonb(ad) from public.attendance_days ad where ad.id=r.id),
      'Removed a stale technical unresolved status from an already Owner-finalized attendance correction. Raw attendance evidence and finalized times were preserved.',
      null
    );
  end loop;
end;
$block$;

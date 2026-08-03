-- Overtime approval records worked time only. It must never create money automatically.
-- Monthly hours are exposed through an authorized summary function for the Admin Dashboard.

alter function public.generate_payroll(uuid)
  rename to generate_payroll_legacy_auto_overtime;

revoke all on function public.generate_payroll_legacy_auto_overtime(uuid) from public, anon, authenticated;

create or replace function public.generate_payroll(p_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare
  v_run_id uuid;
begin
  if not app_private.has_any_role(array['owner','payroll_manager']::public.app_role[]) then
    raise exception 'Not authorized';
  end if;

  v_run_id := public.generate_payroll_legacy_auto_overtime(p_period_id);

  with overtime_amounts as (
    select pc.payroll_item_id, round(coalesce(sum(pc.amount),0),2) as amount
    from public.payroll_components pc
    join public.payroll_items pi on pi.id = pc.payroll_item_id
    where pi.payroll_run_id = v_run_id
      and pc.component_type = 'overtime'
    group by pc.payroll_item_id
  )
  update public.payroll_items pi
  set total_additions = round(greatest(0, pi.total_additions - oa.amount),2),
      net_salary = round(pi.net_salary - oa.amount,2),
      calculation_trace = coalesce(pi.calculation_trace,'{}'::jsonb) || jsonb_build_object(
        'automatic_overtime_payment', false,
        'excluded_automatic_overtime_amount', oa.amount,
        'overtime_payment_rule', 'Owner-approved payroll adjustment required'
      )
  from overtime_amounts oa
  where pi.id = oa.payroll_item_id;

  delete from public.payroll_components pc
  using public.payroll_items pi
  where pc.payroll_item_id = pi.id
    and pi.payroll_run_id = v_run_id
    and pc.component_type = 'overtime';

  update public.payroll_items
  set calculation_trace = coalesce(calculation_trace,'{}'::jsonb) || jsonb_build_object(
    'automatic_overtime_payment', false,
    'overtime_payment_rule', 'Owner-approved payroll adjustment required'
  )
  where payroll_run_id = v_run_id
    and not (coalesce(calculation_trace,'{}'::jsonb) ? 'automatic_overtime_payment');

  return v_run_id;
end;
$function$;

revoke all on function public.generate_payroll(uuid) from public, anon;
grant execute on function public.generate_payroll(uuid) to authenticated;

create or replace function app_private.enforce_owner_overtime_approval()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
begin
  if new.overtime_approval is distinct from old.overtime_approval
     and not app_private.has_any_role(array['owner']::public.app_role[]) then
    raise exception 'Only an Owner can approve or reject overtime';
  end if;

  new.approved_overtime_minutes := case
    when new.overtime_approval = 'approved' then greatest(coalesce(new.overtime_minutes,0),0)
    else 0
  end;

  return new;
end;
$function$;

revoke all on function app_private.enforce_owner_overtime_approval() from public, anon, authenticated;

drop trigger if exists attendance_days_owner_overtime_approval on public.attendance_days;
create trigger attendance_days_owner_overtime_approval
before update of overtime_approval, overtime_minutes, approved_overtime_minutes
on public.attendance_days
for each row execute function app_private.enforce_owner_overtime_approval();

create or replace function public.get_monthly_hours_summary(p_month_start date)
returns table (
  employee_id uuid,
  employee_code text,
  employee_name text,
  required_minutes integer,
  full_month_required_minutes integer,
  worked_minutes integer,
  balance_minutes integer,
  recorded_overtime_minutes integer,
  approved_overtime_minutes integer
)
language plpgsql
security definer
set search_path to 'public', 'app_private'
as $function$
declare
  v_org uuid := app_private.current_organization_id();
  v_month_start date := date_trunc('month', p_month_start)::date;
  v_month_end date := (date_trunc('month', p_month_start) + interval '1 month - 1 day')::date;
  v_cutoff date := least((date_trunc('month', p_month_start) + interval '1 month - 1 day')::date, current_date);
begin
  if v_org is null then raise exception 'Organization context is required'; end if;
  if not app_private.has_any_role(array['owner','hr_admin','payroll_manager','manager','viewer']::public.app_role[]) then
    raise exception 'Not authorized';
  end if;

  return query
  with eligible_employees as (
    select e.id, e.employee_code::text as code, e.full_name
    from public.employees e
    where e.organization_id = v_org
      and e.attendance_required
      and e.status = 'active'
      and (e.hire_date is null or e.hire_date <= v_month_end)
      and (e.termination_date is null or e.termination_date >= v_month_start)
  ),
  daily as (
    select
      ad.employee_id,
      ad.attendance_date,
      ad.is_test_record,
      ad.scheduled_workday,
      coalesce(ad.status_override,ad.status) as effective_status,
      greatest(coalesce(ad.worked_minutes,0),0) as actual_minutes,
      greatest(coalesce(ad.overtime_minutes,0),0) as overtime_recorded,
      greatest(coalesce(ad.approved_overtime_minutes,0),0) as overtime_approved,
      case
        when ad.is_test_record or not ad.scheduled_workday then 0
        when coalesce(ad.status_override,ad.status) in ('leave','holiday','weekend') then 0
        else least(
          greatest(round(coalesce(ad.required_hours,0) * 60)::integer,0),
          case
            when ad.scheduled_start is null or ad.scheduled_end is null then greatest(round(coalesce(ad.required_hours,0) * 60)::integer,0)
            else greatest(
              round(extract(epoch from (
                (ad.attendance_date::timestamp + ad.scheduled_end
                  + case when ad.scheduled_end <= ad.scheduled_start then interval '1 day' else interval '0 day' end)
                - (ad.attendance_date::timestamp + ad.scheduled_start)
              )) / 60)::integer - greatest(coalesce(ad.scheduled_break_minutes,0),0),
              0
            )
          end
        )
      end as target_minutes
    from public.attendance_days ad
    where ad.organization_id = v_org
      and ad.attendance_date between v_month_start and v_month_end
  )
  select
    e.id,
    e.code,
    e.full_name,
    coalesce(sum(d.target_minutes) filter (where d.attendance_date <= v_cutoff),0)::integer as required_minutes,
    coalesce(sum(d.target_minutes),0)::integer as full_month_required_minutes,
    coalesce(sum(d.actual_minutes) filter (where d.attendance_date <= v_cutoff and not d.is_test_record),0)::integer as worked_minutes,
    (
      coalesce(sum(d.actual_minutes) filter (where d.attendance_date <= v_cutoff and not d.is_test_record),0)
      - coalesce(sum(d.target_minutes) filter (where d.attendance_date <= v_cutoff),0)
    )::integer as balance_minutes,
    coalesce(sum(d.overtime_recorded) filter (where d.attendance_date <= v_cutoff and not d.is_test_record),0)::integer as recorded_overtime_minutes,
    coalesce(sum(d.overtime_approved) filter (where d.attendance_date <= v_cutoff and not d.is_test_record),0)::integer as approved_overtime_minutes
  from eligible_employees e
  left join daily d on d.employee_id = e.id
  group by e.id,e.code,e.full_name
  order by e.code;
end;
$function$;

revoke all on function public.get_monthly_hours_summary(date) from public, anon;
grant execute on function public.get_monthly_hours_summary(date) to authenticated;

comment on function public.get_monthly_hours_summary(date) is
  'Returns worked, required and positive/negative monthly hour balances. Test records are excluded and approved leave or shortened authorized schedules reduce required time.';

select app_private.write_audit(
  o.id,
  'CHANGE_OVERTIME_PAYROLL_POLICY',
  'organization',
  o.id::text,
  null,
  jsonb_build_object(
    'automatic_overtime_payment',false,
    'overtime_approval_role','owner',
    'monthly_hours_summary',true
  ),
  'Overtime no longer creates payroll money automatically. Owners review overtime separately and the Attendance page shows monthly worked-hour balances.',
  null
)
from public.organizations o
where o.code='ADSCOPE';
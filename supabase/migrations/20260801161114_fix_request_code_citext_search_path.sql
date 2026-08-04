-- Request-code functions cast generated codes to citext at runtime. The citext
-- extension lives in the locked extensions schema, so include that schema last
-- while preserving the existing public and app_private lookup order.
--
-- These functions may be absent in a clean bootstrap that has not yet imported
-- the production workflow baseline. Each change is therefore conditional so a
-- complete migration replay does not stop on an undefined routine.

do $$
begin
  if to_regprocedure('public.flag_unauthorized_breaks(date)') is not null then
    alter function public.flag_unauthorized_breaks(date)
      set search_path = public, app_private, extensions;
  end if;
end
$$;

do $$
begin
  if to_regprocedure('public.flag_unexcused_absences(date)') is not null then
    alter function public.flag_unexcused_absences(date)
      set search_path = public, app_private, extensions;
  end if;
end
$$;

do $$
begin
  if to_regprocedure('public.submit_advance_request(numeric,text,date,text,uuid)') is not null then
    alter function public.submit_advance_request(numeric, text, date, text, uuid)
      set search_path = public, app_private, extensions;
  end if;
end
$$;

do $$
begin
  if to_regprocedure('public.submit_leave_request(uuid,date,date,text,uuid,text)') is not null then
    alter function public.submit_leave_request(uuid, date, date, text, uuid, text)
      set search_path = public, app_private, extensions;
  end if;
end
$$;

do $$
begin
  if to_regprocedure('public.submit_permission_request(text,date,text,time without time zone,time without time zone,timestamp with time zone,timestamp with time zone,uuid)') is not null then
    alter function public.submit_permission_request(
      text,
      date,
      text,
      time without time zone,
      time without time zone,
      timestamp with time zone,
      timestamp with time zone,
      uuid
    ) set search_path = public, app_private, extensions;
  end if;
end
$$;

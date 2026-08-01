-- Request-code functions cast generated codes to citext at runtime. The citext
-- extension lives in the locked extensions schema, so include that schema last
-- while preserving the existing public and app_private lookup order.

alter function public.flag_unauthorized_breaks(date)
  set search_path = public, app_private, extensions;

alter function public.flag_unexcused_absences(date)
  set search_path = public, app_private, extensions;

alter function public.submit_advance_request(numeric, text, date, text, uuid)
  set search_path = public, app_private, extensions;

alter function public.submit_leave_request(uuid, date, date, text, uuid, text)
  set search_path = public, app_private, extensions;

alter function public.submit_permission_request(
  text,
  date,
  text,
  time without time zone,
  time without time zone,
  timestamp with time zone,
  timestamp with time zone,
  uuid
)
  set search_path = public, app_private, extensions;

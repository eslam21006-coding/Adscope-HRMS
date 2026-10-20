-- Employee appeals already have a dedicated, caller-scoped SQL workflow.
-- Unlike submit_violation_response, this function was SECURITY INVOKER. Employees
-- have SELECT but not UPDATE on public.violations, so their legitimate appeals
-- could not update the case. Keep the existing row/tenant/deadline checks and
-- perform the constrained update under the function owner.
--
-- The existing body selects the violation using:
-- id = p_violation_id
-- AND employee_id = app_private.current_employee_id()
-- AND organization_id = app_private.current_organization_id()
-- It also requires workflow_status='notified' and a valid appeal deadline.
-- No broad UPDATE policy or new employee privilege is granted.

ALTER FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) SECURITY DEFINER;
ALTER FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb)
  SET search_path = pg_catalog, public, app_private;

REVOKE ALL ON FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) TO authenticated;

-- Apply this migration only after review and staging verification.
-- Existing cases, statuses, payroll and audit rows are not changed.

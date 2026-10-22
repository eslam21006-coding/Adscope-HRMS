-- Fix the employee disciplinary appeal authorization path without granting broad
-- UPDATE privileges on violations. All caller identity must come from the signed-in
-- session and must match the selected employee, organization and case.
--
-- Existing SECURITY INVOKER implementation could not update a case through the
-- employee SELECT-only RLS policy. The earlier deadline check also permitted a
-- null deadline because now() > NULL evaluates to NULL, not TRUE.

CREATE OR REPLACE FUNCTION public.submit_disciplinary_appeal(
  p_violation_id uuid,
  p_appeal_reason text,
  p_evidence jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $function$
DECLARE
  v public.violations%ROWTYPE;
  v_emp uuid := app_private.current_employee_id();
  v_org uuid := app_private.current_organization_id();
BEGIN
  IF v_emp IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'An active employee account is required';
  END IF;

  -- A suspended or portal-disabled employee must not submit appeals via RPC.
  IF NOT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = v_emp
      AND e.organization_id = v_org
      AND e.user_id = (SELECT auth.uid())
      AND e.status = 'active'
      AND e.portal_enabled = true
  ) THEN
    RAISE EXCEPTION 'An active employee account is required';
  END IF;

  IF NULLIF(TRIM(p_appeal_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Appeal reason is required';
  END IF;

  SELECT * INTO v
  FROM public.violations
  WHERE id = p_violation_id
    AND employee_id = v_emp
    AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found';
  END IF;

  IF v.workflow_status <> 'notified' THEN
    RAISE EXCEPTION 'This case is not accepting an appeal';
  END IF;

  IF v.appeal_deadline_at IS NULL OR NOW() > v.appeal_deadline_at THEN
    RAISE EXCEPTION 'The 24-hour appeal period has expired';
  END IF;

  UPDATE public.violations SET
    appeal_status = 'pending',
    workflow_status = 'under_review',
    appeal_reason = TRIM(p_appeal_reason),
    appeal_evidence = COALESCE(p_evidence, '[]'::jsonb),
    appeal_submitted_at = NOW(),
    updated_at = NOW()
  WHERE id = v.id;

  PERFORM app_private.notify_owners(
    v_org,
    'disciplinary_appeal',
    'Disciplinary appeal submitted',
    'An employee appealed case ' || v.violation_code || '. Owner review required.',
    'violation',
    v.id
  );
END;
$function$;

-- Do not widen table-level permissions or RLS.
REVOKE ALL ON FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_disciplinary_appeal(uuid, text, jsonb) TO authenticated;

-- Staging test required before applying to production. No existing row is rewritten.

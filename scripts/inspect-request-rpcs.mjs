const supabaseUrl = 'https://fazvuuwgahuxacvgyslf.supabase.co';
const key = 'sb_publishable_F7S5nEal7qghrczR7v0k8A_6GEPMbDq';
const zeroUuid = '00000000-0000-0000-0000-000000000000';

const probes = {
  submit_permission_request: [
    ['compat-current', {p_request_type:null,p_request_date:null,p_reason:null,p_requested_start_time:null,p_requested_end_time:null,p_corrected_check_in:null,p_corrected_check_out:null,p_employee_id:zeroUuid}],
    ['compat-corrected-at', {p_request_type:null,p_request_date:null,p_reason:null,p_requested_start_time:null,p_requested_end_time:null,p_corrected_check_in_at:null,p_corrected_check_out_at:null,p_employee_id:zeroUuid}],
    ['original-v1-employee', {p_request_type:null,p_request_date:null,p_reason:null,p_late_start_time:null,p_early_leave_time:null,p_corrected_check_in_at:null,p_corrected_check_out_at:null,p_employee_id:zeroUuid}],
    ['original-v2-employee', {p_type:null,p_date:null,p_reason:null,p_late_start_time:null,p_early_leave_time:null,p_corrected_check_in:null,p_corrected_check_out:null,p_employee_id:zeroUuid}],
    ['original-v3-employee', {p_permission_type:null,p_date:null,p_reason:null,p_start_time:null,p_end_time:null,p_check_in_at:null,p_check_out_at:null,p_employee_id:zeroUuid}],
    ['original-v1-request-id', {p_request_type:null,p_request_date:null,p_reason:null,p_late_start_time:null,p_early_leave_time:null,p_corrected_check_in_at:null,p_corrected_check_out_at:null,p_idempotency_key:zeroUuid}],
    ['compat-request-id', {p_request_type:null,p_request_date:null,p_reason:null,p_requested_start_time:null,p_requested_end_time:null,p_corrected_check_in:null,p_corrected_check_out:null,p_request_id:zeroUuid}]
  ],
  submit_leave_request: [
    ['compat-current', {p_leave_type_id:zeroUuid,p_start_date:null,p_end_date:null,p_reason:null,p_employee_id:zeroUuid,p_document_path:null}],
    ['attachment-employee', {p_leave_type_id:zeroUuid,p_start_date:null,p_end_date:null,p_reason:null,p_employee_id:zeroUuid,p_attachment_id:null}],
    ['type-attachment-request', {p_type_id:zeroUuid,p_start_date:null,p_end_date:null,p_reason:null,p_attachment_id:null,p_request_id:zeroUuid}],
    ['leave-idempotency', {p_leave_type_id:zeroUuid,p_start_date:null,p_end_date:null,p_reason:null,p_attachment_id:null,p_idempotency_key:zeroUuid}],
    ['from-to-medical', {p_leave_type_id:zeroUuid,p_from_date:null,p_to_date:null,p_reason:null,p_medical_attachment_id:null,p_request_key:zeroUuid}]
  ],
  submit_advance_request: [
    ['compat-current', {p_amount:null,p_currency:null,p_deduction_month:null,p_reason:null,p_employee_id:zeroUuid}],
    ['request-id', {p_amount:null,p_currency:null,p_deduction_month:null,p_reason:null,p_request_id:zeroUuid}],
    ['idempotency', {p_amount:null,p_currency:null,p_deduction_month:null,p_reason:null,p_idempotency_key:zeroUuid}],
    ['payroll-request', {p_amount:null,p_currency:null,p_payroll_month:null,p_reason:null,p_request_id:zeroUuid}],
    ['selected-request', {p_amount:null,p_currency:null,p_selected_month:null,p_reason:null,p_request_id:zeroUuid}]
  ],
  submit_violation_response: [
    ['response', {p_violation_id:zeroUuid,p_response:null}],
    ['reason', {p_violation_id:zeroUuid,p_reason:null}],
    ['typed-response', {p_violation_id:zeroUuid,p_response:null,p_response_type:null}]
  ]
};

for (const [name, candidates] of Object.entries(probes)) {
  console.log(`\n===== ${name} =====`);
  for (const [label, body] of candidates) {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let code = '';
    try { code = JSON.parse(text)?.code || ''; } catch {}
    console.log(`${label}: status=${response.status} code=${code} ${text.slice(0,500)}`);
  }
}

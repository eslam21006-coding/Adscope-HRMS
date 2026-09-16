(() => {
  'use strict';

  if (!window.supabase?.createClient) return;

  const originalCreateClient = window.supabase.createClient.bind(window.supabase);

  window.supabase.createClient = function createAdscopePortalClient(...args) {
    const client = originalCreateClient(...args);
    const originalRpc = client.rpc.bind(client);
    const originalFrom = client.from.bind(client);
    let currentEmployeeId = null;

    const rememberEmployee = data => {
      const id = data?.employee_id || data?.id || data?.employee?.id || null;
      if (id) currentEmployeeId = id;
      return data;
    };

    client.from = function from(table) {
      return originalFrom(table === 'advance_requests' ? 'advances' : table);
    };

    client.rpc = async function rpc(name, payload = {}) {
      if (name === 'get_my_attendance_profile') {
        const attendanceProfile = await originalRpc(name, payload);
        if (attendanceProfile.error) return attendanceProfile;
        let merged = rememberEmployee(attendanceProfile.data) || {};

        try {
          const portalProfile = await originalRpc('get_my_employee_portal_profile', {});
          if (!portalProfile.error && portalProfile.data) {
            merged = { ...merged, ...portalProfile.data };
            rememberEmployee(merged);
          }
        } catch {
          // Attendance profile remains sufficient for core portal boot.
        }

        return { ...attendanceProfile, data: merged };
      }

      if (name === 'submit_permission_request') {
        const p = payload || {};
        const normalized = {
          p_request_type: p.p_request_type || p.p_type || p.p_permission_type || null,
          p_request_date: p.p_request_date || p.p_date || null,
          p_reason: p.p_reason || null,
          p_requested_start_time: p.p_requested_start_time || p.p_late_start_time || p.p_start_time || null,
          p_requested_end_time: p.p_requested_end_time || p.p_early_leave_time || p.p_end_time || null,
          p_corrected_check_in: p.p_corrected_check_in || p.p_corrected_check_in_at || p.p_check_in_at || null,
          p_corrected_check_out: p.p_corrected_check_out || p.p_corrected_check_out_at || p.p_check_out_at || null,
          p_employee_id: currentEmployeeId
        };
        return originalRpc(name, normalized);
      }

      if (name === 'submit_leave_request') {
        const p = payload || {};
        const normalized = {
          p_leave_type_id: p.p_leave_type_id || p.p_type_id || null,
          p_start_date: p.p_start_date || p.p_from_date || null,
          p_end_date: p.p_end_date || p.p_to_date || null,
          p_reason: p.p_reason || null,
          p_employee_id: currentEmployeeId,
          p_document_path: p.p_document_path || null
        };
        return originalRpc(name, normalized);
      }

      if (name === 'submit_advance_request') {
        const p = payload || {};
        const normalized = {
          p_amount: p.p_amount,
          p_currency: p.p_currency,
          p_deduction_month: p.p_deduction_month || p.p_payroll_month || p.p_selected_month || null,
          p_reason: p.p_reason || null,
          p_employee_id: currentEmployeeId
        };
        return originalRpc(name, normalized);
      }

      if (name === 'submit_violation_response') {
        const p = payload || {};
        return originalRpc(name, {
          p_violation_id: p.p_violation_id,
          p_response: p.p_response
        });
      }

      return originalRpc(name, payload);
    };

    return client;
  };
})();

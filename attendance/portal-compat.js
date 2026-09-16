(() => {
  'use strict';

  if (!window.supabase?.createClient) return;

  const originalCreateClient = window.supabase.createClient.bind(window.supabase);
  const requestCache = new Map();
  const violationIntent = new Map();
  const REQUEST_DEDUPE_MS = 120000;
  const orderColumns = {
    attendance_days: 'attendance_date',
    leave_requests: 'start_date',
    permission_requests: 'created_at',
    advances: 'created_at',
    violations: 'violation_date',
    notifications: 'created_at'
  };

  function stableRequestKey(name, payload) {
    const entries = Object.entries(payload || {}).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([name, entries]);
  }

  function dedupedRpc(originalRpc, name, payload) {
    const key = stableRequestKey(name, payload);
    const cached = requestCache.get(key);
    if (cached && Date.now() - cached.createdAt < REQUEST_DEDUPE_MS) return cached.promise;

    const promise = Promise.resolve(originalRpc(name, payload)).then(
      result => {
        if (result?.error) requestCache.delete(key);
        return result;
      },
      error => {
        requestCache.delete(key);
        throw error;
      }
    );

    requestCache.set(key, { createdAt: Date.now(), promise });
    window.setTimeout(() => {
      if (requestCache.get(key)?.promise === promise) requestCache.delete(key);
    }, REQUEST_DEDUPE_MS);
    return promise;
  }

  function browserWallPartsFromIso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return {
      year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds()
    };
  }

  function partsInZone(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });
    const map = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return {
      year: Number(map.year), month: Number(map.month), day: Number(map.day),
      hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second)
    };
  }

  function utcValue(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  }

  function wallClockToZoneIso(parts, timeZone) {
    if (!parts) return null;
    const desired = utcValue(parts);
    let instant = desired;
    for (let i = 0; i < 3; i += 1) {
      const displayed = partsInZone(new Date(instant), timeZone);
      const delta = desired - utcValue(displayed);
      if (!delta) break;
      instant += delta;
    }
    return new Date(instant).toISOString();
  }

  function normalizeCorrectionTimestamp(value, timeZone) {
    const wall = browserWallPartsFromIso(value);
    return wall ? wallClockToZoneIso(wall, timeZone) : value || null;
  }

  function wrapQuery(builder, table) {
    if (!builder || typeof builder !== 'object') return builder;
    return new Proxy(builder, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'then' && typeof value === 'function') return value.bind(target);
        if (property === 'limit' && typeof value === 'function' && orderColumns[table]) {
          return limit => wrapQuery(target.order(orderColumns[table], { ascending: false }).limit(limit), table);
        }
        if (typeof value === 'function') {
          return (...args) => {
            const result = value.apply(target, args);
            return result && typeof result === 'object' ? wrapQuery(result, table) : result;
          };
        }
        return value;
      }
    });
  }

  function wrapNotificationQuery(builder, originalFrom, getUserId, state = {}) {
    if (!builder || typeof builder !== 'object') return builder;
    return new Proxy(builder, {
      get(target, property) {
        const value = Reflect.get(target, property, target);

        if (property === 'then') {
          return (onFulfilled, onRejected) => {
            const execute = async () => {
              const first = await target;
              if (first?.error || first?.data?.length || !state.employeeFilter || !getUserId()) return first;

              let fallback = originalFrom('notifications').select(...(state.selectArgs || ['*'])).eq('user_id', getUserId()).order('created_at', { ascending: false });
              if (state.limit != null) fallback = fallback.limit(state.limit);
              const second = await fallback;
              return !second?.error && second?.data?.length ? second : first;
            };
            return execute().then(onFulfilled, onRejected);
          };
        }

        if (property === 'select' && typeof value === 'function') {
          return (...args) => wrapNotificationQuery(value.apply(target, args), originalFrom, getUserId, { ...state, selectArgs: args });
        }

        if (property === 'eq' && typeof value === 'function') {
          return (column, eqValue) => wrapNotificationQuery(value.call(target, column, eqValue), originalFrom, getUserId, {
            ...state,
            employeeFilter: column === 'employee_id' ? eqValue : state.employeeFilter
          });
        }

        if (property === 'limit' && typeof value === 'function') {
          return limit => wrapNotificationQuery(target.order('created_at', { ascending: false }).limit(limit), originalFrom, getUserId, { ...state, limit });
        }

        if (typeof value === 'function') {
          return (...args) => {
            const result = value.apply(target, args);
            return result && typeof result === 'object'
              ? wrapNotificationQuery(result, originalFrom, getUserId, state)
              : result;
          };
        }
        return value;
      }
    });
  }

  function installTimezoneAwareAdvanceDefault(timeZone) {
    const apply = () => {
      const input = document.querySelector('#advanceForm input[name="month"]');
      if (!input || input.dataset.adscopeTimezoneDefault === '1') return;
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit'
      }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
      input.value = `${parts.year}-${parts.month}`;
      input.dataset.adscopeTimezoneDefault = '1';
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(apply, 0);
  }

  installTimezoneAwareAdvanceDefault(window.ADSCOPE_CONFIG?.timezone || 'Africa/Cairo');

  window.supabase.createClient = function createAdscopePortalClient(...args) {
    const client = originalCreateClient(...args);
    const originalRpc = client.rpc.bind(client);
    const originalFrom = client.from.bind(client);
    const originalGetSession = client.auth.getSession.bind(client.auth);
    let currentEmployeeId = null;
    let currentUserId = null;

    client.auth.getSession = async (...sessionArgs) => {
      const result = await originalGetSession(...sessionArgs);
      currentUserId = result?.data?.session?.user?.id || currentUserId;
      return result;
    };

    const rememberEmployee = data => {
      const id = data?.employee_id || data?.id || data?.employee?.id || null;
      if (id) currentEmployeeId = id;
      return data;
    };

    client.from = function from(table) {
      const mapped = table === 'advance_requests' ? 'advances' : table;
      const raw = originalFrom(mapped);
      if (mapped === 'notifications') return wrapNotificationQuery(raw, originalFrom, () => currentUserId);
      return wrapQuery(raw, mapped);
    };

    client.rpc = async function rpc(name, payload = {}) {
      if (name === 'get_my_attendance_profile') {
        const attendanceProfile = await originalRpc(name, payload);
        if (attendanceProfile.error) return attendanceProfile;
        let merged = rememberEmployee(attendanceProfile.data) || {};

        try {
          const portalProfile = await originalRpc('get_my_employee_portal_profile', {});
          if (!portalProfile.error && portalProfile.data) {
            merged = { ...portalProfile.data, ...merged };
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
          p_corrected_check_in: normalizeCorrectionTimestamp(
            p.p_corrected_check_in || p.p_corrected_check_in_at || p.p_check_in_at || null,
            window.ADSCOPE_CONFIG?.timezone || 'Africa/Cairo'
          ),
          p_corrected_check_out: normalizeCorrectionTimestamp(
            p.p_corrected_check_out || p.p_corrected_check_out_at || p.p_check_out_at || null,
            window.ADSCOPE_CONFIG?.timezone || 'Africa/Cairo'
          ),
          p_employee_id: currentEmployeeId
        };
        return dedupedRpc(originalRpc, name, normalized);
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
        return dedupedRpc(originalRpc, name, normalized);
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
        return dedupedRpc(originalRpc, name, normalized);
      }

      if (name === 'submit_violation_response') {
        const p = payload || {};
        if (p.p_violation_id) violationIntent.set(String(p.p_violation_id), p.p_response_type || 'response');
        return dedupedRpc(originalRpc, name, {
          p_violation_id: p.p_violation_id,
          p_response: p.p_response
        });
      }

      if (name === 'submit_violation_appeal') {
        const p = payload || {};
        if (violationIntent.get(String(p.p_violation_id)) !== 'appeal') {
          return {
            data: null,
            error: { code: 'PGRST202', message: 'Appeal-only workflow was not selected for this response.' }
          };
        }
      }

      return originalRpc(name, payload);
    };

    return client;
  };
})();

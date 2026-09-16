(() => {
  'use strict';

  if (!window.supabase?.createClient) return;

  const requestNames = new Set([
    'submit_permission_request',
    'submit_leave_request',
    'submit_advance_request',
    'submit_violation_response',
    'respond_to_violation',
    'submit_violation_appeal'
  ]);

  const technicalPattern = /\b(sql|postgres|postgrest|schema|constraint|column|relation|table|row-level security|rls|function public\.|pgrst\d+|stack|syntax error)\b/i;

  function cleanBusinessMessage(value) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (!raw || technicalPattern.test(raw)) return '';
    return raw
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, 'the selected record')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'the account')
      .slice(0, 240);
  }

  function friendlyRequestError(error) {
    const raw = String(error?.message || error || '').trim();
    const code = String(error?.code || '').trim();

    if (code === '42501' || /permission denied|not authorized/i.test(raw)) {
      return 'Your Employee Portal account is not authorized to submit this request. Contact an Owner.';
    }
    if (code === 'PGRST202' || /could not find the function|schema cache|parameters/i.test(raw)) {
      return 'The request service is temporarily out of sync. Refresh the portal and try again.';
    }
    if (code === '23505' || /already exists|duplicate/i.test(raw)) {
      return 'A matching request already exists. Check Request History before submitting another one.';
    }
    if (/overlap/i.test(raw)) {
      return 'This request overlaps an existing request or attendance record.';
    }
    if (/balance|insufficient/i.test(raw)) {
      return 'This request cannot be submitted with the current available balance.';
    }
    if (/past|future|date|time|start|end|attendance|leave|advance|request/i.test(raw)) {
      const cleaned = cleanBusinessMessage(raw);
      if (cleaned) return cleaned;
    }
    if (code === 'P0001') {
      const cleaned = cleanBusinessMessage(raw);
      if (cleaned) return cleaned;
    }
    return 'The request could not be submitted. Try again once. If it still fails, contact an Owner.';
  }

  let lastRequestError = null;
  const originalCreateClient = window.supabase.createClient.bind(window.supabase);

  window.supabase.createClient = function createClientWithReadableRequestErrors(...args) {
    const client = originalCreateClient(...args);
    const originalRpc = client.rpc.bind(client);

    client.rpc = async function rpcWithReadableRequestErrors(name, payload = {}) {
      const result = await originalRpc(name, payload);
      if (requestNames.has(name) && result?.error) {
        lastRequestError = {
          at: Date.now(),
          message: friendlyRequestError(result.error)
        };
      }
      return result;
    };

    return client;
  };

  function installToastGuard() {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const text = String(node.textContent || '').trim();
          if (!/Something went wrong\. Refresh the portal and try again\./i.test(text)) continue;
          if (!lastRequestError || Date.now() - lastRequestError.at > 15000) continue;
          node.textContent = lastRequestError.message;
        }
      }
    });
    observer.observe(root, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installToastGuard, { once: true });
  } else {
    installToastGuard();
  }
})();

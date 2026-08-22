(() => {
  'use strict';

  const cfg = window.ADSCOPE_CONFIG;
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const app = document.getElementById('portalApp');
  const toastRoot = document.getElementById('toastRoot');
  const REQUEST_TIMEOUT_MS = 15000;

  let session = null;
  let profile = null;
  let attendance = null;
  let events = [];
  let clockTimer = null;
  let booting = null;

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const localDate = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const time = value => new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value));

  function withTimeout(promise, message = 'The request took too long. Check your connection and try again.') {
    let timer;
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT_MS);
      })
    ]);
  }

  function toast(message) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    toastRoot.append(node);
    setTimeout(() => node.remove(), 5000);
  }

  function friendlyError(error) {
    const raw = String(error?.message || error || '').trim();
    if (/not linked to an employee/i.test(raw)) return 'This account is not linked to an employee profile.';
    if (/attendance is not required/i.test(raw)) return 'Your account does not require daily attendance.';
    if (/portal access is disabled/i.test(raw)) return 'Attendance portal access is not enabled for this account.';
    if (/already have an active attendance shift/i.test(raw)) return raw;
    if (/No active attendance shift/i.test(raw)) return raw;
    if (/needs Owner review/i.test(raw)) return raw;
    if (/attendance is already complete/i.test(raw)) return raw;
    if (/invalid login credentials/i.test(raw)) return 'The email or password is incorrect.';
    if (/email not confirmed/i.test(raw)) return 'Please confirm your email address before signing in.';
    if (/origin not allowed/i.test(raw)) return 'This attendance page is not authorized yet. Contact the system administrator.';
    if (/permission denied|not authorized|row-level security/i.test(raw)) return 'Your account does not have permission to use this attendance action.';
    if (/jwt.*expired|token.*expired|session.*expired/i.test(raw)) return 'Your session has expired. Sign in again and repeat the action.';
    if (/non-2xx|edge function|functionshttperror|functionsrelayerror|functionsfetchederror|failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
      return 'The HR service could not be reached. Check your connection and try again.';
    }
    if (/took too long|timed out|timeout/i.test(raw)) return 'The request took too long. Check your connection and try again.';
    return 'Something went wrong. Refresh the portal and try again.';
  }

  function loading(message = 'Loading attendance portal…') {
    app.innerHTML = `<div class="loading"><div><div class="spinner"></div>${esc(message)}</div></div>`;
  }

  function retryView(message) {
    app.innerHTML = `<section class="page"><div class="card" role="alert">
      <div class="brand"><div class="mark">A</div><div><div class="title">Unable to open attendance</div><div class="sub">Secure employee portal</div></div></div>
      <div class="notice">${esc(message)}</div>
      <p>The page stopped waiting instead of remaining on a loading screen.</p>
      <div class="stack"><button class="primary" id="retryPortal">Retry</button>${session ? '<button class="ghost" id="logout">Log out</button>' : ''}</div>
    </div></section>`;
    document.getElementById('retryPortal').onclick = () => bootOnce().catch(error => retryView(friendlyError(error)));
    const logout = document.getElementById('logout');
    if (logout) logout.onclick = () => client.auth.signOut();
  }

  function login(message = '') {
    app.innerHTML = `<section class="page"><div class="card">
      <div class="brand"><div class="mark">A</div><div><div class="title">Adscope Attendance</div><div class="sub">Secure employee portal</div></div></div>
      <h1>Sign in</h1><p>Use your assigned Adscope account.</p>
      ${message ? `<div class="notice">${esc(message)}</div>` : ''}
      <form id="login"><label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label><label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Sign in</button></form>
      <button class="link" id="forgot">Forgot password?</button>
    </div></section>`;

    document.getElementById('login').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        const result = await withTimeout(client.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') }));
        if (result.error) throw result.error;
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Sign in';
        login(friendlyError(error));
      }
    };

    document.getElementById('forgot').onclick = async () => {
      const email = prompt('Enter your email address');
      if (!email) return;
      const redirectTo = new URL('/attendance/', location.origin).href;
      try {
        const result = await withTimeout(client.auth.resetPasswordForEmail(email, { redirectTo }));
        if (result.error) throw result.error;
        toast('Password reset email sent.');
      } catch (error) {
        toast(friendlyError(error));
      }
    };
  }

  async function load() {
    const profileResult = await withTimeout(client.rpc('get_my_attendance_profile'));
    if (profileResult.error) throw profileResult.error;
    profile = profileResult.data;

    const attendanceResult = await withTimeout(client.rpc('get_my_attendance_state'));
    if (attendanceResult.error) throw attendanceResult.error;
    attendance = attendanceResult.data || {};
    events = Array.isArray(attendance.events) ? attendance.events : [];
  }

  function currentState() {
    return attendance?.state || 'not-in';
  }

  function allowed() {
    return Array.isArray(attendance?.allowed_actions) ? attendance.allowed_actions : [];
  }

  function label(type) {
    return { CHECK_IN: 'Check In', BREAK_START: 'Start Break', BREAK_END: 'End Break', CHECK_OUT: 'Check Out' }[type] || type;
  }

  function render() {
    const state = currentState();
    const employeeName = profile.full_name || profile.employee_name || profile.employee?.full_name || 'Employee';
    const shift = attendance?.shift || profile.shift || {};
    const shiftName = shift.name || profile.shift_name || 'Assigned shift';
    const previous = attendance?.previous_review;
    const previousNotice = previous
      ? `<div class="notice"><strong>Previous attendance needs correction</strong><p>${esc(previous.attendance_date)} — ${esc(previous.reason || 'A previous record needs Owner review.')} This does not block today’s attendance.</p></div>`
      : '';
    const currentNotice = attendance?.requires_owner_review
      ? `<div class="notice"><strong>Attendance review required</strong><p>${esc(attendance.review_reason || 'This record needs Owner review before it becomes final.')}</p></div>`
      : '';

    app.innerHTML = `<section class="page"><div class="card">
      <div class="header"><div class="brand"><div class="mark">A</div><div><div class="title">Attendance</div><div class="sub">${esc(employeeName)}</div></div></div><button class="link" id="logout">Log out</button></div>
      <div class="status-card"><div class="status">${esc(state.replaceAll('-', ' '))}</div><div class="clock" id="clock"></div></div>
      ${previousNotice}${currentNotice}
      <div class="details"><div class="detail"><span>Shift date</span><strong>${esc(attendance?.shift_date || localDate())}</strong></div><div class="detail"><span>Shift</span><strong>${esc(shiftName)}</strong></div></div>
      <div class="stack">${allowed().map(type => `<button class="${type === 'CHECK_OUT' ? 'danger' : type === 'CHECK_IN' ? 'primary' : 'secondary'}" data-action="${type}">${label(type)}</button>`).join('')}${allowed().length ? '' : state === 'done' ? '<div class="notice success">Today’s attendance sequence is complete.</div>' : state === 'needs-review' ? '<div class="notice">This record needs Owner review. Submit an Attendance correction if the recorded times are incomplete.</div>' : ''}</div>
      <div class="events"><strong>Current shift events</strong>${events.map(event => `<div class="event"><span>${esc(label(event.event_type))}</span><strong>${esc(time(event.occurred_at))}</strong></div>`).join('') || '<p>No attendance events for the current shift.</p>'}</div>
    </div></section>`;

    document.getElementById('logout').onclick = () => client.auth.signOut();
    app.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = () => record(button.dataset.action, button);
    });

    const updateClock = () => {
      const element = document.getElementById('clock');
      if (element) element.textContent = new Intl.DateTimeFormat('en-GB', {
        timeZone: cfg.timezone, dateStyle: 'full', timeStyle: 'medium'
      }).format(new Date());
    };
    updateClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateClock, 1000);
  }

  async function record(type, button) {
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      let { data, error } = await withTimeout(client.functions.invoke('attendance-event', {
        body: { type, idempotencyKey: crypto.randomUUID() }
      }));

      if (error && (!data || !data.error)) {
        const context = error.context;
        if (context && typeof context.json === 'function') {
          try { data = await context.json(); } catch {}
        }
      }
      if (error || data?.error) throw new Error(data?.error || data?.message || error?.message || 'Attendance action failed');

      const warnings = [data?.review_warning, data?.late_warning].filter(Boolean);
      toast(warnings.join(' ') || `${label(type)} recorded.`);
      await load();
      render();
    } catch (error) {
      button.disabled = false;
      button.textContent = label(type);
      toast(friendlyError(error));
    }
  }

  async function boot() {
    loading();
    const sessionResult = await withTimeout(client.auth.getSession());
    if (sessionResult.error) throw sessionResult.error;
    session = sessionResult.data.session;
    if (!session) return login();

    try {
      await load();
      render();
    } catch (error) {
      const message = friendlyError(error);
      if (/not linked to an employee|does not require daily attendance|portal access is not enabled|does not have permission/i.test(message)) {
        app.innerHTML = `<section class="page"><div class="card"><div class="brand"><div class="mark">A</div><div><div class="title">Attendance unavailable</div><div class="sub">Account signed in</div></div></div><div class="notice">${esc(message)}</div><p>This account may be an administrator, exempt from daily attendance, inactive, or not enabled for the employee portal.</p><button class="ghost" id="logout">Log out</button></div></section>`;
        document.getElementById('logout').onclick = () => client.auth.signOut();
        return;
      }
      retryView(message);
    }
  }

  function bootOnce() {
    if (booting) return booting;
    booting = boot().finally(() => { booting = null; });
    return booting;
  }

  client.auth.onAuthStateChange((event, nextSession) => {
    window.setTimeout(() => {
      const previousUserId = session?.user?.id;
      session = nextSession;
      if (!nextSession || event === 'SIGNED_OUT') return login();
      if (previousUserId === nextSession.user?.id && profile) return;
      bootOnce().catch(error => retryView(friendlyError(error)));
    }, 0);
  });

  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload();
  });

  bootOnce().catch(error => retryView(friendlyError(error)));
})();

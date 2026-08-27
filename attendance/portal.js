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
  let pageRequest = 0;

  const pageMeta = {
    home: ['Home', 'Your Adscope employee workspace'],
    attendance: ['Attendance', 'Check in, breaks, checkout and attendance history'],
    requests: ['Requests', 'Permissions and attendance corrections'],
    leave: ['Leave', 'Balances, history and leave requests'],
    advances: ['Salary Advances', 'Request an advance and track its status'],
    violations: ['Violations', 'Notices, investigations and your responses'],
    notifications: ['Notifications', 'HRMS updates and decisions'],
    profile: ['Profile', 'Your employee information']
  };

  const navItems = [
    ['home', 'Home', 'H'],
    ['attendance', 'Attendance', 'A'],
    ['requests', 'Requests', 'R'],
    ['leave', 'Leave', 'L'],
    ['advances', 'Advances', '$'],
    ['violations', 'Violations', '!'],
    ['notifications', 'Notifications', 'N'],
    ['profile', 'Profile', 'P']
  ];

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const employeeId = () => profile?.employee_id || profile?.id || profile?.employee?.id || null;
  const employeeName = () => profile?.full_name || profile?.employee_name || profile?.employee?.full_name || 'Employee';
  const organizationId = () => profile?.organization_id || profile?.employee?.organization_id || null;
  const portalTimeFormat = () => String(profile?.time_format || profile?.organization_time_format || cfg.timeFormat || '12').startsWith('24') ? '24' : '12';
  const localDate = value => new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value ? new Date(value) : new Date());
  const dateText = value => value ? new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.timezone, day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(value)) : '—';
  const time = value => value ? new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: portalTimeFormat() === '12'
  }).format(new Date(value)) : '—';
  const dateTime = value => value ? new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.timezone, dateStyle: 'medium', timeStyle: 'short', hour12: portalTimeFormat() === '12'
  }).format(new Date(value)) : '—';
  const minutesText = value => {
    const n = Math.max(0, Number(value || 0));
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const money = (value, currency = 'EGP') => {
    try { return new Intl.NumberFormat('en-EG', { style:'currency', currency, maximumFractionDigits:2 }).format(Number(value || 0)); }
    catch { return `${Number(value || 0).toFixed(2)} ${currency}`; }
  };

  function withTimeout(promise, message = 'The request took too long. Check your connection and try again.') {
    let timer;
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT_MS);
      })
    ]);
  }

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    toastRoot.append(node);
    setTimeout(() => node.remove(), 5000);
  }

  function friendlyError(error) {
    const raw = String(error?.message || error || '').trim();
    if (/not linked to an employee/i.test(raw)) return 'This account is not linked to an employee profile.';
    if (/attendance is not required/i.test(raw)) return 'Daily attendance is not required for this employee.';
    if (/portal access is disabled/i.test(raw)) return 'Employee Portal access is not enabled for this account.';
    if (/already have an active attendance shift/i.test(raw)) return 'You already have an active attendance shift.';
    if (/No active attendance shift/i.test(raw)) return 'There is no active attendance shift for this action.';
    if (/needs Owner review/i.test(raw)) return 'This attendance record needs Owner review before it becomes final.';
    if (/attendance is already complete/i.test(raw)) return 'Today’s attendance sequence is already complete.';
    if (/invalid login credentials/i.test(raw)) return 'The email or password is incorrect.';
    if (/email not confirmed/i.test(raw)) return 'Please confirm your email address before signing in.';
    if (/origin not allowed/i.test(raw)) return 'This Employee Portal page is not authorized yet. Contact an Owner.';
    if (/permission denied|not authorized|row-level security/i.test(raw)) return 'You do not have permission to perform this action.';
    if (/jwt.*expired|token.*expired|session.*expired/i.test(raw)) return 'Your session has expired. Sign in again and repeat the action.';
    if (/already exists|duplicate/i.test(raw)) return 'This request appears to have already been submitted.';
    if (/overlap/i.test(raw)) return 'This request overlaps an existing request or attendance record.';
    if (/balance|insufficient/i.test(raw)) return 'This request cannot be submitted with the current available balance.';
    if (/non-2xx|edge function|functionshttperror|functionsrelayerror|functionsfetchederror|failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
      return 'The HR service could not be reached. Check your connection and try again.';
    }
    if (/took too long|timed out|timeout/i.test(raw)) return 'The request took too long. Check your connection and try again.';
    return 'Something went wrong. Refresh the portal and try again.';
  }

  function loading(message = 'Loading employee portal…') {
    app.innerHTML = `<div class="loading"><div><div class="spinner"></div>${esc(message)}</div></div>`;
  }

  function retryView(message) {
    app.innerHTML = `<section class="simple-page"><div class="simple-card" role="alert">
      <div class="brand"><div class="mark">A</div><div><div class="title">Unable to open attendance or Employee Portal</div><div class="sub">Secure employee workspace</div></div></div>
      <div class="notice error">${esc(message)}</div>
      <p>The page stopped waiting instead of remaining on a loading screen.</p>
      <div class="button-row"><button class="primary" id="retryPortal">Retry</button>${session ? '<button class="ghost" id="logout">Log out</button>' : ''}</div>
    </div></section>`;
    document.getElementById('retryPortal').onclick = () => bootOnce().catch(error => retryView(friendlyError(error)));
    const logout = document.getElementById('logout');
    if (logout) logout.onclick = () => client.auth.signOut();
  }

  function login(message = '') {
    app.innerHTML = `<section class="login-page"><div class="login-card">
      <div class="brand"><div class="mark">A</div><div><div class="title">Adscope Employee Portal</div><div class="sub">Secure employee self-service</div></div></div>
      <h1>Sign in</h1><p>Use your assigned Adscope account.</p>
      ${message ? `<div class="notice error">${esc(message)}</div>` : ''}
      <form id="login"><label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label><label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><button class="primary full" type="submit">Sign in</button></form>
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
        toast('Password reset email sent.', 'success');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
    };
  }

  async function load() {
    const profileResult = await withTimeout(client.rpc('get_my_attendance_profile'));
    if (profileResult.error) throw profileResult.error;
    profile = profileResult.data;
    if (!employeeId()) throw new Error('This account is not linked to an employee profile.');

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

  function badge(value) {
    const text = String(value || 'unknown').replaceAll('_', ' ');
    const cls = /approved|active|present|complete|closed|paid|final/i.test(text) ? ' green' : /rejected|denied|absent|cancel|invalid/i.test(text) ? ' red' : /pending|review|open|submitted|late/i.test(text) ? ' gold' : '';
    return `<span class="badge${cls}">${esc(text)}</span>`;
  }

  function sortRows(rows) {
    const keys = ['created_at','submitted_at','request_date','attendance_date','start_date','violation_date','date'];
    return [...(rows || [])].sort((a,b) => {
      const key = keys.find(k => a?.[k] != null || b?.[k] != null);
      if (!key) return 0;
      return String(b?.[key] || '').localeCompare(String(a?.[key] || ''));
    });
  }

  async function optionalQuery(factory) {
    try {
      const result = await withTimeout(factory());
      if (result.error) return { data: [], available: false };
      return { data: result.data || [], available: true };
    } catch {
      return { data: [], available: false };
    }
  }

  async function ownRows(table, limit = 100) {
    const id = employeeId();
    if (!id) return { data: [], available: false };
    return optionalQuery(() => client.from(table).select('*').eq('employee_id', id).limit(limit));
  }

  async function loadLeaveTypes() {
    let query = client.from('leave_types').select('*');
    if (organizationId()) query = query.eq('organization_id', organizationId());
    const result = await optionalQuery(() => query.limit(100));
    return result;
  }

  function sectionUnavailable(copy = 'This section could not be loaded. Your other Employee Portal sections are still available.') {
    return `<div class="notice info"><strong>Section temporarily unavailable</strong><p>${esc(copy)}</p></div>`;
  }

  function currentPage() {
    const requested = location.hash.replace(/^#\/?/, '').split('?')[0];
    return pageMeta[requested] ? requested : 'home';
  }

  function renderShell() {
    const current = currentPage();
    const nav = navItems.map(([id,labelText,icon]) => `<button class="nav-item ${id === current ? 'active' : ''}" data-page="${id}"><span class="nav-icon">${esc(icon)}</span><span>${esc(labelText)}</span></button>`).join('');
    app.innerHTML = `<div class="workspace" id="workspace">
      <aside class="sidebar">
        <div class="sidebar-head"><div class="mark">A</div><div><div class="title">Adscope</div><div class="sub">Employee Portal</div></div></div>
        <div class="employee-summary"><strong>${esc(employeeName())}</strong><span>${esc(profile?.employee_code || profile?.code || 'Employee')}</span></div>
        <nav class="nav" aria-label="Employee Portal">${nav}</nav>
        <div class="sidebar-foot"><button class="ghost" id="logout">Log out</button></div>
      </aside>
      <div class="scrim" id="scrim"></div>
      <section class="main">
        <header class="topbar"><div style="display:flex;align-items:center;gap:11px"><button class="menu-button" id="menuButton" aria-label="Open menu">Menu</button><div><h1 id="pageTitle"></h1><p id="pageSubtitle"></p></div></div><div class="sub" id="topClock"></div></header>
        <main class="content" id="portalContent"></main>
      </section>
      <nav class="mobile-nav" aria-label="Quick navigation">
        <button data-mobile-page="home">Home</button><button data-mobile-page="attendance">Attendance</button><button data-mobile-page="requests">Requests</button><button id="mobileMore">More</button>
      </nav>
    </div>`;

    const workspace = document.getElementById('workspace');
    const closeMenu = () => workspace.classList.remove('menu-open');
    document.getElementById('menuButton').onclick = () => workspace.classList.toggle('menu-open');
    document.getElementById('scrim').onclick = closeMenu;
    document.getElementById('mobileMore').onclick = () => workspace.classList.add('menu-open');
    document.getElementById('logout').onclick = () => client.auth.signOut();
    app.querySelectorAll('[data-page]').forEach(button => button.onclick = () => {
      closeMenu();
      navigate(button.dataset.page);
    });
    app.querySelectorAll('[data-mobile-page]').forEach(button => button.onclick = () => navigate(button.dataset.mobilePage));

    updateShellState(current);
    updateTopClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopClock, 1000);
  }

  function updateTopClock() {
    const element = document.getElementById('topClock');
    if (!element) return;
    element.textContent = new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg.timezone, weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12: portalTimeFormat() === '12'
    }).format(new Date());
  }

  function updateShellState(page) {
    const [titleText, subtitleText] = pageMeta[page];
    const title = document.getElementById('pageTitle');
    const subtitle = document.getElementById('pageSubtitle');
    if (title) title.textContent = titleText;
    if (subtitle) subtitle.textContent = subtitleText;
    app.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
    app.querySelectorAll('[data-mobile-page]').forEach(button => button.classList.toggle('active', button.dataset.mobilePage === page));
  }

  function navigate(page) {
    if (!pageMeta[page]) page = 'home';
    if (location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
    updateShellState(page);
    loadPage(page);
  }

  async function loadPage(page = currentPage()) {
    const content = document.getElementById('portalContent');
    if (!content) return;
    const requestId = ++pageRequest;
    updateShellState(page);
    content.innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    try {
      const renderer = {
        home: renderHome,
        attendance: renderAttendance,
        requests: renderRequests,
        leave: renderLeave,
        advances: renderAdvances,
        violations: renderViolations,
        notifications: renderNotifications,
        profile: renderProfile
      }[page];
      const html = await renderer();
      if (requestId !== pageRequest) return;
      content.innerHTML = html;
      bindPage(page, content);
    } catch (error) {
      if (requestId !== pageRequest) return;
      content.innerHTML = `<div class="notice error"><strong>Unable to open this section</strong><p>${esc(friendlyError(error))}</p></div><button class="primary" id="retrySection">Retry</button>`;
      document.getElementById('retrySection').onclick = () => loadPage(page);
    }
  }

  async function renderHome() {
    const [leaves, permissions, advances, violations, notifications] = await Promise.all([
      ownRows('leave_requests', 50), ownRows('permission_requests', 50), ownRows('advance_requests', 50), ownRows('violations', 50), loadNotifications(50)
    ]);
    const pending = [...leaves.data, ...permissions.data, ...advances.data].filter(row => /pending|submitted|review/i.test(String(row.status || row.workflow_status || ''))).length;
    const openViolations = violations.data.filter(row => !/final|rejected|closed/i.test(String(row.workflow_status || row.status || ''))).length;
    const unread = notifications.data.filter(row => !(row.is_read ?? row.read ?? row.read_at)).length;
    const state = currentState();
    const shift = attendance?.shift || profile?.shift || {};
    return `<div class="grid three">
      <div class="metric"><span>Attendance</span><strong>${esc(state.replaceAll('-', ' '))}</strong></div>
      <div class="metric"><span>Pending requests</span><strong>${pending}</strong></div>
      <div class="metric"><span>Unread notifications</span><strong>${unread}</strong></div>
    </div>
    <div class="grid two" style="margin-top:16px">
      <section class="panel"><header class="panel-head"><div><h2>Today</h2><p>${esc(attendance?.shift_date || localDate())}</p></div>${badge(state)}</header><div class="panel-body">
        <div class="details"><div class="detail"><span>Shift</span><strong>${esc(shift.name || profile?.shift_name || 'Assigned shift')}</strong></div><div class="detail"><span>Current state</span><strong>${esc(state.replaceAll('-', ' '))}</strong></div></div>
        <div class="section-actions"><button class="primary" data-go="attendance">Open Attendance</button><button class="secondary" data-go="requests">Submit a request</button></div>
      </div></section>
      <section class="panel"><header class="panel-head"><div><h2>Needs attention</h2><p>Your current HRMS items</p></div></header><div class="panel-body">
        ${attendance?.previous_review ? `<div class="notice"><strong>Attendance correction needed</strong><p>${esc(attendance.previous_review.attendance_date)} — ${esc(attendance.previous_review.reason || 'A previous record needs review.')}</p></div>` : ''}
        ${openViolations ? `<div class="notice"><strong>${openViolations} open violation ${openViolations === 1 ? 'case' : 'cases'}</strong><p>Open Violations to view the notice and response status.</p></div>` : ''}
        ${!attendance?.previous_review && !openViolations ? '<div class="notice success"><strong>No urgent items</strong><p>No attendance correction or open violation is currently flagged here.</p></div>' : ''}
      </div></section>
    </div>`;
  }

  async function renderAttendance() {
    const history = await ownRows('attendance_days', 120);
    const state = currentState();
    const shift = attendance?.shift || profile?.shift || {};
    const previous = attendance?.previous_review;
    const rows = sortRows(history.data).map(day => `<tr>
      <td>${esc(day.attendance_date || '—')}</td><td>${badge(day.status || day.session_state)}</td>
      <td>${esc(time(day.finalized_check_in_at || day.check_in_at))}</td><td>${esc(time(day.finalized_check_out_at || day.check_out_at))}</td>
      <td>${esc(minutesText(day.finalized_break_minutes ?? day.break_minutes))}</td><td>${esc(minutesText(day.worked_minutes))}</td>
      <td>${day.requires_owner_review || day.system_issue ? badge('needs review') : '—'}</td>
    </tr>`).join('');
    return `<section class="panel"><header class="panel-head"><div><h2>Current shift</h2><p>Your attendance actions are controlled by the server-side shift state.</p></div></header><div class="panel-body">
      <div class="status-card"><div><div class="status">${esc(state.replaceAll('-', ' '))}</div><div class="sub">${esc(attendance?.shift_date || localDate())}</div></div><div class="clock" id="attendanceClock"></div></div>
      ${previous ? `<div class="notice"><strong>Previous attendance needs correction</strong><p>${esc(previous.attendance_date)} — ${esc(previous.reason || 'A previous record needs Owner review.')} This does not block today’s attendance.</p><button class="secondary" data-go="requests" style="margin-top:10px">Submit attendance correction</button></div>` : ''}
      ${attendance?.requires_owner_review ? `<div class="notice"><strong>Attendance review required</strong><p>${esc(attendance.review_reason || 'This record needs Owner review before it becomes final.')}</p></div>` : ''}
      <div class="details"><div class="detail"><span>Shift date</span><strong>${esc(attendance?.shift_date || localDate())}</strong></div><div class="detail"><span>Shift</span><strong>${esc(shift.name || profile?.shift_name || 'Assigned shift')}</strong></div></div>
      <div class="stack">${allowed().map(type => `<button class="${type === 'CHECK_OUT' ? 'danger' : type === 'CHECK_IN' ? 'primary' : 'secondary'}" data-action="${type}">${label(type)}</button>`).join('')}${allowed().length ? '' : state === 'done' ? '<div class="notice success">Today’s attendance sequence is complete.</div>' : state === 'needs-review' ? '<div class="notice">This record needs Owner review. Submit an Attendance correction if the recorded times are incomplete.</div>' : ''}</div>
      <div class="events"><strong>Current shift events</strong>${events.map(event => `<div class="event"><span>${esc(label(event.event_type))}</span><strong>${esc(time(event.occurred_at))}</strong></div>`).join('') || '<p class="sub">No attendance events for the current shift.</p>'}</div>
    </div></section>
    <section class="panel" style="margin-top:16px"><header class="panel-head"><div><h2>Attendance history</h2><p>Recent recorded attendance days.</p></div></header>${history.available ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Status</th><th>Check in</th><th>Check out</th><th>Break</th><th>Worked</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table>${rows ? '' : '<div class="empty">No attendance history is available yet.</div>'}</div>` : `<div class="panel-body">${sectionUnavailable('Attendance history could not be loaded. Current Check In, Break and Check Out remain available above.')}</div>`}</section>`;
  }

  async function renderRequests() {
    const requests = await ownRows('permission_requests', 100);
    const rows = sortRows(requests.data).map(item => `<tr><td>${esc(item.request_code || item.code || '—')}</td><td>${esc(String(item.request_type || item.type || item.permission_type || 'Request').replaceAll('_',' '))}</td><td>${esc(item.request_date || item.attendance_date || item.date || '—')}</td><td>${badge(item.status || item.workflow_status)}</td><td>${esc(item.reason || item.notes || '')}</td></tr>`).join('');
    return `<section class="panel"><header class="panel-head"><div><h2>Submit a request</h2><p>Permissions apply only to the requested date. Attendance corrections preserve the original attendance evidence.</p></div></header><div class="panel-body">
      <div class="request-picker"><button class="request-card" data-request-form="late_start"><strong>Late start permission</strong><span>Ask to start later on one date.</span></button><button class="request-card" data-request-form="early_leave"><strong>Early leave permission</strong><span>Ask to leave earlier on one date.</span></button><button class="request-card" data-request-form="attendance_correction"><strong>Attendance correction</strong><span>Correct incomplete or incorrect recorded times.</span></button></div>
      <div id="requestFormHost"></div>
    </div></section>
    <section class="panel" style="margin-top:16px"><header class="panel-head"><div><h2>Request history</h2><p>Owner decisions appear here when available.</p></div></header>${requests.available ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Type</th><th>Date</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>${rows ? '' : '<div class="empty">No permission or correction requests yet.</div>'}</div>` : `<div class="panel-body">${sectionUnavailable('Request history could not be loaded. You can still use the request forms above; if submission is unavailable, the form will tell you without losing access to the portal.')}</div>`}</section>`;
  }

  async function renderLeave() {
    const [requests, types, balances] = await Promise.all([ownRows('leave_requests', 100), loadLeaveTypes(), ownRows('leave_balances', 50)]);
    const typeMap = new Map(types.data.map(type => [String(type.id), type]));
    const requestRows = sortRows(requests.data).map(item => {
      const type = typeMap.get(String(item.leave_type_id)) || {};
      return `<tr><td>${esc(item.leave_code || item.request_code || '—')}</td><td>${esc(type.name || item.leave_type_name || 'Leave')}</td><td>${esc(item.start_date || '—')} → ${esc(item.end_date || '—')}</td><td>${esc(item.requested_days ?? item.days ?? '—')}</td><td>${badge(item.status)}</td><td>${esc(item.reason || '')}</td></tr>`;
    }).join('');
    const balanceCards = balances.available && balances.data.length ? balances.data.map(row => {
      const type = typeMap.get(String(row.leave_type_id)) || {};
      const remaining = row.remaining_days ?? row.available_days ?? row.balance_days ?? row.balance ?? '—';
      return `<div class="metric"><span>${esc(type.name || row.leave_type_name || 'Leave balance')}</span><strong>${esc(remaining)}</strong></div>`;
    }).join('') : '<div class="metric"><span>Leave balance</span><strong>—</strong></div>';
    const options = types.data.filter(t => t.is_active !== false).map(type => `<option value="${esc(type.id)}">${esc(type.name || type.name_en || type.code || 'Leave')}</option>`).join('');
    return `<div class="grid three">${balanceCards}</div>
    <section class="panel" style="margin-top:16px"><header class="panel-head"><div><h2>Request leave</h2><p>Annual, emergency, sick and unpaid leave decisions require Owner approval.</p></div></header><div class="panel-body">
      ${types.available && options ? `<form id="leaveForm"><div class="form-grid"><label class="field"><span>Leave type</span><select name="leave_type_id" required><option value="">Select leave type</option>${options}</select></label><label class="field"><span>Start date</span><input name="start_date" type="date" required></label><label class="field"><span>End date</span><input name="end_date" type="date" required></label><label class="field wide"><span>Reason</span><textarea name="reason" required></textarea></label></div><button class="primary" type="submit">Submit leave request</button></form>` : sectionUnavailable('Leave types could not be loaded, so the system has disabled leave submission rather than guessing the leave policy.')}
    </div></section>
    <section class="panel" style="margin-top:16px"><header class="panel-head"><div><h2>Leave history</h2><p>Your recent leave requests and decisions.</p></div></header>${requests.available ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Reason</th></tr></thead><tbody>${requestRows}</tbody></table>${requestRows ? '' : '<div class="empty">No leave requests yet.</div>'}</div>` : `<div class="panel-body">${sectionUnavailable('Leave history could not be loaded.')}</div>`}</section>`;
  }

  async function renderAdvances() {
    const advances = await ownRows('advance_requests', 100);
    const rows = sortRows(advances.data).map(item => `<tr><td>${esc(item.advance_code || item.request_code || item.code || '—')}</td><td>${esc(money(item.amount, item.currency || profile?.payroll_currency || 'EGP'))}</td><td>${esc(item.deduction_month || item.payroll_month || item.requested_payroll_month || '—')}</td><td>${badge(item.status || item.workflow_status)}</td><td>${esc(item.reason || '')}</td></tr>`).join('');
    const defaultMonth = new Date().toISOString().slice(0,7);
    return `<section class="panel"><header class="panel-head"><div><h2>Request salary advance</h2><p>An approved advance is deducted once in the selected payroll period. Approval is Owner-only.</p></div></header><div class="panel-body"><form id="advanceForm"><div class="form-grid"><label class="field"><span>Amount</span><input name="amount" type="number" min="1" step="0.01" required></label><label class="field"><span>Currency</span><input name="currency" value="${esc(profile?.payroll_currency || 'EGP')}" required></label><label class="field"><span>Deduction month</span><input name="month" type="month" value="${defaultMonth}" required></label><label class="field wide"><span>Reason</span><textarea name="reason" required></textarea></label></div><button class="primary" type="submit">Submit advance request</button></form></div></section>
    <section class="panel" style="margin-top:16px"><header class="panel-head"><div><h2>Advance history</h2><p>Rejected requests make no payroll change.</p></div></header>${advances.available ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Amount</th><th>Deduction month</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>${rows ? '' : '<div class="empty">No salary advance requests yet.</div>'}</div>` : `<div class="panel-body">${sectionUnavailable('Advance history could not be loaded. The submission form remains available and will fail safely if the request service is unavailable.')}</div>`}</section>`;
  }

  async function renderViolations() {
    const violations = await ownRows('violations', 100);
    const rows = sortRows(violations.data).map(item => `<tr><td>${esc(item.violation_code || item.code || '—')}</td><td>${esc(item.violation_date || item.date || '—')}</td><td>${esc(String(item.violation_type || item.type_name || item.category || 'Violation').replaceAll('_',' '))}</td><td>${badge(item.workflow_status || item.status)}</td><td>${esc(item.description || item.allegation || item.reason || '')}</td><td>${item.workflow_status && !/final|rejected|closed/i.test(item.workflow_status) ? `<button class="secondary" data-respond-violation="${esc(item.id)}">Respond</button>` : '—'}</td></tr>`).join('');
    return `<section class="panel"><header class="panel-head"><div><h2>Violations & investigations</h2><p>You can view notices here and submit your response. Final sanctions remain subject to Owner review.</p></div></header>${violations.available ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Date</th><th>Type</th><th>Status</th><th>Allegation</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>${rows ? '' : '<div class="empty">No violation notices are assigned to you.</div>'}</div>` : `<div class="panel-body">${sectionUnavailable('Violation records could not be loaded.')}</div>`}</section><div id="violationResponseHost"></div>`;
  }

  async function loadNotifications(limit = 100) {
    const id = employeeId();
    const uid = session?.user?.id;
    if (!id && !uid) return { data: [], available: false };
    const attempts = [];
    if (id) attempts.push(() => client.from('notifications').select('*').eq('employee_id', id).limit(limit));
    if (uid) attempts.push(() => client.from('notifications').select('*').eq('user_id', uid).limit(limit));
    for (const attempt of attempts) {
      const result = await optionalQuery(attempt);
      if (result.available) return result;
    }
    return { data: [], available: false };
  }

  async function renderNotifications() {
    const notifications = await loadNotifications(100);
    const rows = sortRows(notifications.data);
    if (!notifications.available) return `<section class="panel"><header class="panel-head"><div><h2>Notifications</h2><p>HRMS updates and Owner decisions.</p></div></header><div class="panel-body">${sectionUnavailable('Notifications could not be loaded. This does not affect attendance or your other portal sections.')}</div></section>`;
    return `<section class="panel"><header class="panel-head"><div><h2>Notifications</h2><p>${rows.filter(row => !(row.is_read ?? row.read ?? row.read_at)).length} unread</p></div></header><div class="panel-body"><div class="stack">${rows.map(row => `<div class="detail"><span>${esc(dateTime(row.created_at || row.sent_at || row.updated_at))}</span><strong>${esc(row.title || row.subject || String(row.type || 'HRMS notification').replaceAll('_',' '))}</strong><p class="sub" style="margin:5px 0 0">${esc(row.message || row.body || row.text || '')}</p></div>`).join('') || '<div class="empty">No notifications yet.</div>'}</div></div></section>`;
  }

  async function renderProfile() {
    const values = [
      ['Full name', employeeName()],
      ['Employee code', profile?.employee_code || profile?.code],
      ['Email', profile?.email || session?.user?.email],
      ['Job title', profile?.job_title || profile?.title],
      ['Department', profile?.department_name || profile?.department?.name],
      ['Employment type', profile?.employment_type || profile?.type],
      ['Start date', profile?.hire_date || profile?.employment_start_date || profile?.start_date],
      ['Shift', profile?.shift_name || profile?.shift?.name || attendance?.shift?.name],
      ['Timezone', profile?.timezone || cfg.timezone],
      ['Time format', `${portalTimeFormat()}-hour`]
    ];
    return `<section class="panel"><header class="panel-head"><div><h2>Profile</h2><p>Your current employee information. Contact an Owner if a record needs correction.</p></div></header><div class="panel-body"><div class="profile-grid">${values.map(([key,value]) => `<div class="kv"><span>${esc(key)}</span><strong>${esc(value || '—')}</strong></div>`).join('')}</div></div></section>`;
  }

  function bindPage(page, content) {
    content.querySelectorAll('[data-go]').forEach(button => button.onclick = () => navigate(button.dataset.go));
    if (page === 'attendance') bindAttendance(content);
    if (page === 'requests') bindRequests(content);
    if (page === 'leave') bindLeave(content);
    if (page === 'advances') bindAdvances(content);
    if (page === 'violations') bindViolations(content);
  }

  function bindAttendance(content) {
    content.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = () => record(button.dataset.action, button);
    });
    const updateClock = () => {
      const element = document.getElementById('attendanceClock');
      if (element) element.textContent = new Intl.DateTimeFormat('en-GB', {
        timeZone: cfg.timezone, dateStyle: 'full', timeStyle: 'medium', hour12: portalTimeFormat() === '12'
      }).format(new Date());
    };
    updateClock();
  }

  function requestForm(type) {
    const today = localDate();
    if (type === 'late_start') return `<form id="permissionForm" data-permission-type="late_start"><div class="form-grid"><label class="field"><span>Date</span><input name="date" type="date" min="${today}" required></label><label class="field"><span>Approved start time requested</span><input name="late_start_time" type="time" required></label><label class="field wide"><span>Reason</span><textarea name="reason" required></textarea></label></div><button class="primary" type="submit">Submit for Owner approval</button></form>`;
    if (type === 'early_leave') return `<form id="permissionForm" data-permission-type="early_leave"><div class="form-grid"><label class="field"><span>Date</span><input name="date" type="date" min="${today}" required></label><label class="field"><span>Approved leave time requested</span><input name="early_leave_time" type="time" required></label><label class="field wide"><span>Reason</span><textarea name="reason" required></textarea></label></div><button class="primary" type="submit">Submit for Owner approval</button></form>`;
    return `<form id="permissionForm" data-permission-type="attendance_correction"><div class="form-grid"><label class="field"><span>Attendance date</span><input name="date" type="date" max="${today}" required></label><label class="field"><span>Correct check-in</span><input name="corrected_check_in" type="datetime-local"></label><label class="field"><span>Correct check-out</span><input name="corrected_check_out" type="datetime-local"></label><label class="field wide"><span>What needs correction?</span><textarea name="reason" required></textarea></label></div><button class="primary" type="submit">Submit attendance correction</button></form>`;
  }

  function bindRequests(content) {
    const host = content.querySelector('#requestFormHost');
    content.querySelectorAll('[data-request-form]').forEach(button => button.onclick = () => {
      host.innerHTML = `<div class="notice info"><strong>${esc(button.querySelector('strong').textContent)}</strong><p>Complete the form below. Only an Owner can approve or reject it.</p></div>${requestForm(button.dataset.requestForm)}`;
      bindPermissionForm(host.querySelector('#permissionForm'));
      host.scrollIntoView({ behavior:'smooth', block:'nearest' });
    });
    if (attendance?.previous_review) {
      const correction = content.querySelector('[data-request-form="attendance_correction"]');
      if (correction) correction.click();
    }
  }

  async function rpcCandidates(name, candidates) {
    let mismatch = null;
    for (const args of candidates) {
      const result = await withTimeout(client.rpc(name, args));
      if (!result.error) return result.data;
      const raw = String(result.error.message || '');
      if (result.error.code === 'PGRST202' || /could not find the function|schema cache|parameters/i.test(raw)) {
        mismatch = result.error;
        continue;
      }
      throw result.error;
    }
    throw mismatch || new Error('Request service unavailable');
  }

  function bindPermissionForm(form) {
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      const fd = new FormData(form);
      const type = form.dataset.permissionType;
      const idempotency = crypto.randomUUID();
      const date = fd.get('date');
      const late = fd.get('late_start_time') || null;
      const early = fd.get('early_leave_time') || null;
      const correctedIn = fd.get('corrected_check_in') ? new Date(fd.get('corrected_check_in')).toISOString() : null;
      const correctedOut = fd.get('corrected_check_out') ? new Date(fd.get('corrected_check_out')).toISOString() : null;
      const reason = fd.get('reason');
      const candidates = [
        { p_request_type:type,p_request_date:date,p_reason:reason,p_late_start_time:late,p_early_leave_time:early,p_corrected_check_in_at:correctedIn,p_corrected_check_out_at:correctedOut,p_idempotency_key:idempotency },
        { p_type:type,p_date:date,p_reason:reason,p_late_start_time:late,p_early_leave_time:early,p_corrected_check_in:correctedIn,p_corrected_check_out:correctedOut,p_request_id:idempotency },
        { p_permission_type:type,p_date:date,p_reason:reason,p_start_time:late,p_end_time:early,p_check_in_at:correctedIn,p_check_out_at:correctedOut,p_idempotency_key:idempotency }
      ];
      button.disabled = true;
      button.textContent = 'Submitting…';
      try {
        await rpcCandidates('submit_permission_request', candidates);
        toast('Request submitted for Owner review.', 'success');
        await load();
        loadPage('requests');
      } catch (error) {
        button.disabled = false;
        button.textContent = type === 'attendance_correction' ? 'Submit attendance correction' : 'Submit for Owner approval';
        toast(friendlyError(error), 'error');
      }
    };
  }

  function bindLeave(content) {
    const form = content.querySelector('#leaveForm');
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(form);
      const button = form.querySelector('[type="submit"]');
      const requestId = crypto.randomUUID();
      const common = {
        typeId:fd.get('leave_type_id'), start:fd.get('start_date'), end:fd.get('end_date'), reason:fd.get('reason')
      };
      const candidates = [
        { p_leave_type_id:common.typeId,p_start_date:common.start,p_end_date:common.end,p_reason:common.reason,p_attachment_id:null,p_idempotency_key:requestId },
        { p_type_id:common.typeId,p_start_date:common.start,p_end_date:common.end,p_reason:common.reason,p_attachment_id:null,p_request_id:requestId },
        { p_leave_type_id:common.typeId,p_from_date:common.start,p_to_date:common.end,p_reason:common.reason,p_medical_attachment_id:null,p_request_key:requestId }
      ];
      button.disabled = true;
      button.textContent = 'Submitting…';
      try {
        await rpcCandidates('submit_leave_request', candidates);
        toast('Leave request submitted for Owner review.', 'success');
        loadPage('leave');
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Submit leave request';
        toast(friendlyError(error), 'error');
      }
    };
  }

  function bindAdvances(content) {
    const form = content.querySelector('#advanceForm');
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(form);
      const button = form.querySelector('[type="submit"]');
      const requestId = crypto.randomUUID();
      const deductionDate = `${fd.get('month')}-01`;
      const amount = Number(fd.get('amount'));
      const currency = String(fd.get('currency') || '').toUpperCase();
      const reason = fd.get('reason');
      const candidates = [
        { p_amount:amount,p_currency:currency,p_deduction_month:deductionDate,p_reason:reason,p_idempotency_key:requestId },
        { p_amount:amount,p_currency:currency,p_payroll_month:deductionDate,p_reason:reason,p_request_id:requestId },
        { p_amount:amount,p_currency:currency,p_selected_month:deductionDate,p_reason:reason,p_request_id:requestId }
      ];
      button.disabled = true;
      button.textContent = 'Submitting…';
      try {
        await rpcCandidates('submit_advance_request', candidates);
        toast('Salary advance request submitted for Owner review.', 'success');
        loadPage('advances');
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Submit advance request';
        toast(friendlyError(error), 'error');
      }
    };
  }

  function bindViolations(content) {
    const host = content.querySelector('#violationResponseHost');
    content.querySelectorAll('[data-respond-violation]').forEach(button => button.onclick = () => {
      host.innerHTML = `<section class="panel" style="margin-top:16px"><header class="panel-head"><div><h2>Respond to violation</h2><p>Your response is recorded for Owner review.</p></div></header><div class="panel-body"><form id="violationResponseForm" data-violation-id="${esc(button.dataset.respondViolation)}"><label class="field"><span>Your response / appeal</span><textarea name="response" required></textarea></label><label class="field"><span>Response type</span><select name="response_type"><option value="response">Response</option><option value="appeal">Appeal</option></select></label><button class="primary" type="submit">Submit response</button></form></div></section>`;
      bindViolationResponse(host.querySelector('#violationResponseForm'));
      host.scrollIntoView({ behavior:'smooth', block:'nearest' });
    });
  }

  function isRpcMismatch(error) {
    return error?.code === 'PGRST202' || /could not find the function|schema cache|parameters/i.test(String(error?.message || ''));
  }

  async function bindViolationResponse(form) {
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(form);
      const button = form.querySelector('[type="submit"]');
      const violationId = form.dataset.violationId;
      const responseText = fd.get('response');
      const responseType = fd.get('response_type');
      const attempts = [
        ['submit_violation_response', { p_violation_id:violationId,p_response:responseText,p_response_type:responseType }],
        ['respond_to_violation', { p_violation_id:violationId,p_response:responseText,p_is_appeal:responseType === 'appeal' }],
        ['submit_violation_appeal', { p_violation_id:violationId,p_reason:responseText }]
      ];
      button.disabled = true;
      button.textContent = 'Submitting…';
      let lastError = null;
      try {
        for (const [name,args] of attempts) {
          const result = await withTimeout(client.rpc(name,args));
          if (!result.error) {
            toast('Your response was submitted for Owner review.', 'success');
            loadPage('violations');
            return;
          }
          if (!isRpcMismatch(result.error)) throw result.error;
          lastError = result.error;
        }
        throw lastError || new Error('Response service unavailable');
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Submit response';
        toast(friendlyError(error), 'error');
      }
    };
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
      toast(warnings.join(' ') || `${label(type)} recorded.`, 'success');
      await load();
      loadPage('attendance');
    } catch (error) {
      button.disabled = false;
      button.textContent = label(type);
      toast(friendlyError(error), 'error');
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
      renderShell();
      await loadPage(currentPage());
    } catch (error) {
      const message = friendlyError(error);
      if (/not linked to an employee|Portal access is not enabled|does not have permission/i.test(message)) {
        app.innerHTML = `<section class="simple-page"><div class="simple-card"><div class="brand"><div class="mark">A</div><div><div class="title">Employee Portal unavailable</div><div class="sub">Account signed in</div></div></div><div class="notice error">${esc(message)}</div><p>This account may be inactive or not enabled for Employee Portal access.</p><button class="ghost" id="logout">Log out</button></div></section>`;
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

  window.addEventListener('hashchange', () => {
    if (profile && document.getElementById('portalContent')) loadPage(currentPage());
  });

  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload();
  });

  bootOnce().catch(error => retryView(friendlyError(error)));
})();

(() => {
  'use strict';

  const cfg = window.ADSCOPE_CONFIG;
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const state = {
    session: null,
    membership: null,
    organization: null,
    page: 'dashboard',
    month: new Date().toISOString().slice(0, 7),
    menuOpen: false
  };

  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modalRoot');
  const toastRoot = document.getElementById('toastRoot');

  const pageMeta = {
    dashboard: ['Dashboard', 'Company workforce overview'],
    employees: ['Employees', 'Employee records, shifts and compensation'],
    attendance: ['Attendance', 'Monthly attendance review and corrections'],
    leaves: ['Leaves', 'Leave requests and approval workflow'],
    violations: ['Violations', 'Policy incidents and payroll consequences'],
    payroll: ['Payroll', 'Monthly salary calculation and approval'],
    policies: ['Policies', 'Company handbook clauses and violation matrix'],
    audit: ['Audit Log', 'Immutable operational activity history']
  };

  const navItems = [
    ['dashboard', 'Overview', ['owner','hr_admin','payroll_manager','manager','viewer']],
    ['employees', 'Employees', ['owner','hr_admin','payroll_manager','manager','viewer']],
    ['attendance', 'Attendance', ['owner','hr_admin','manager','viewer']],
    ['leaves', 'Leaves', ['owner','hr_admin','manager','viewer']],
    ['violations', 'Violations', ['owner','hr_admin','manager','viewer']],
    ['payroll', 'Payroll', ['owner','payroll_manager']],
    ['policies', 'Company Policies', ['owner','hr_admin','payroll_manager','manager','viewer']],
    ['audit', 'Audit Log', ['owner']]
  ];

  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const money = (value, currency = 'EGP') => new Intl.NumberFormat('en-EG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));
  const dateFmt = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: cfg.timezone }).format(new Date(value)) : '—';
  const timeFmt = (value) => value ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: cfg.timezone }).format(new Date(value)) : '—';
  const startOfMonth = () => `${state.month}-01`;
  const endOfMonth = () => {
    const [y, m] = state.month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10);
  };
  const role = () => state.membership?.role || 'viewer';
  const can = (...roles) => roles.includes(role());

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }


  function humanizeError(error) {
    const raw = String(error?.message || error || 'Something went wrong.');
    const rules = [
      [/Close attendance before generating payroll/i, 'Attendance must be closed before payroll can be generated.'],
      [/(\d+) unresolved attendance day\(s\) remain/i, match => `${match[1]} attendance days still need review before the month can be closed.`],
      [/Payroll preflight failed:\s*(.*)/i, 'Payroll is not ready yet. Run the payroll check to see what still needs attention.'],
      [/permission denied for schema app_private/i, 'This action could not be completed because of a server permission issue.'],
      [/permission denied/i, 'You do not have permission to perform this action.'],
      [/more than one relationship was found/i, 'The system found an unclear data connection. Please refresh and try again.'],
      [/Payroll period not found/i, 'The payroll month could not be found. Refresh the page and try again.'],
      [/Not authorized/i, 'Your account is not authorized to perform this action.'],
      [/No compensation profile for\s+(.+)/i, match => `${match[1]} does not have a valid compensation profile for this month.`],
      [/has no valid base salary/i, raw],
      [/has no assigned shift/i, raw],
      [/has no payroll currency/i, raw],
      [/has no generated attendance schedule/i, raw],
      [/has \d+ unresolved attendance day\(s\)/i, raw],
      [/Pending leave requests intersect this period/i, 'One or more pending leave requests overlap this payroll month.'],
      [/Pending commissions exist for this period/i, 'One or more commissions are still awaiting approval for this payroll month.'],
      [/Unresolved violations or appeals exist for this period/i, 'One or more violations or appeals are still unresolved for this payroll month.'],
      [/Payroll is stale; regenerate first/i, 'Payroll inputs changed after the last calculation. Generate payroll again before continuing.'],
      [/Invalid payroll status transition/i, 'This payroll step cannot be completed in the current status.'],
      [/Only Owner can/i, raw],
      [/Only Owner or Payroll Manager can/i, raw]
    ];
    for (const [pattern, output] of rules) {
      const match = raw.match(pattern);
      if (match) return typeof output === 'function' ? output(match) : output;
    }
    return raw
      .replaceAll('_', ' ')
      .replace(/\bapp private\b/gi, 'the secured payroll service')
      .replace(/\bRPC\b/g, 'system action');
  }

  function listHtml(items, className = 'plain-list') {
    if (!Array.isArray(items) || !items.length) return '';
    return `<ul class="${className}">${items.map(item => `<li>${esc(humanizeError(item))}</li>`).join('')}</ul>`;
  }

  function monthLabel(value = startOfMonth()) {
    const date = new Date(`${String(value).slice(0, 7)}-01T00:00:00Z`);
    return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function ordinal(number) {
    const n = Number(number);
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
  }

  function formatPenaltyFractions(value) {
    let values = value;
    if (typeof values === 'string') {
      try { values = JSON.parse(values); } catch { return values; }
    }
    if (!Array.isArray(values) || !values.length) return 'Defined by the active policy';
    return values.map((fraction, index) => {
      const percent = Math.round(Number(fraction || 0) * 100);
      return `${ordinal(index + 1)} occurrence: ${percent === 0 ? 'documented warning' : `${percent}% of the daily rate`}`;
    }).join(' · ');
  }

  function payrollActionMessage(name, data, args = {}) {
    if (name === 'generate_attendance_month') {
      const total = Number(data?.total || 0);
      const created = Number(data?.created || 0);
      const title = created > 0 ? 'Attendance schedule created' : 'Attendance schedule already exists';
      const copy = created > 0
        ? `${created} attendance records were created for ${monthLabel(data?.month_start || startOfMonth())}. The month now contains ${total} records.`
        : `No duplicate records were created. ${monthLabel(data?.month_start || startOfMonth())} already contains ${total} attendance records.`;
      return `<div class="notice success"><strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;
    }

    if (name === 'payroll_preflight') {
      const blockers = Array.isArray(data?.blockers) ? data.blockers : [];
      const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
      if (data?.ok) {
        return `<div class="notice success"><strong>Payroll check passed</strong><p>No blocking issues were found. You can close attendance after the month-end review is complete.</p>${warnings.length ? `<p><strong>Notes</strong></p>${listHtml(warnings)}` : ''}</div>`;
      }
      return `<div class="notice warning"><strong>Payroll is not ready yet</strong><p>Resolve the following items before closing attendance:</p>${listHtml(blockers)}${warnings.length ? `<p><strong>Additional notes</strong></p>${listHtml(warnings)}` : ''}</div>`;
    }

    if (name === 'close_attendance_period') {
      return `<div class="notice success"><strong>Attendance closed</strong><p>${esc(monthLabel())} is locked for payroll. You can now generate payroll.</p></div>`;
    }

    if (name === 'generate_payroll') {
      return `<div class="notice success"><strong>Payroll generated</strong><p>The salary calculation for ${esc(monthLabel())} is ready. Review the employee breakdown below before approval.</p></div>`;
    }

    if (name === 'advance_payroll_status') {
      const target = String(args.p_target || '').replaceAll('_', ' ');
      const messages = {
        reviewed: 'Payroll has been reviewed and is ready for Owner approval.',
        approved: 'Payroll has been approved.',
        paid: 'Payroll has been marked as paid.',
        locked: 'Payroll has been locked. Further changes require reopening the payroll period.'
      };
      return `<div class="notice success"><strong>Payroll updated</strong><p>${esc(messages[target] || `Payroll is now ${target}.`)}</p></div>`;
    }

    return `<div class="notice success"><strong>Action completed</strong><p>Your changes were saved successfully.</p></div>`;
  }

  function renderPayrollDetails(item) {
    const components = Array.isArray(item.components) ? item.components : [];
    const rows = components.map(component => {
      const amount = Number(component.amount || 0);
      return `<tr><td>${esc(component.description || String(component.component_type || '').replaceAll('_', ' '))}</td><td class="amount ${amount < 0 ? 'negative' : 'positive'}">${money(amount, component.currency || item.currency)}</td></tr>`;
    }).join('');
    return `<div class="details-grid">
      <div><span>Basic salary</span><strong>${money(item.basic_salary, item.currency)}</strong></div>
      <div><span>Scheduled workdays</span><strong>${esc(item.scheduled_service_days)}</strong></div>
      <div><span>Present days</span><strong>${esc(item.present_days)}</strong></div>
      <div><span>Absent days</span><strong>${esc(item.absent_days)}</strong></div>
      <div><span>Paid leave days</span><strong>${esc(item.paid_leave_days)}</strong></div>
      <div><span>Unpaid leave days</span><strong>${esc(item.unpaid_leave_days)}</strong></div>
      <div><span>Approved overtime</span><strong>${esc(item.approved_overtime_minutes || 0)} minutes</strong></div>
      <div><span>Late minutes</span><strong>${esc(item.raw_late_minutes || 0)} minutes</strong></div>
      <div><span>Total additions</span><strong>${money(item.total_additions, item.currency)}</strong></div>
      <div><span>Total deductions</span><strong>${money(item.total_deductions, item.currency)}</strong></div>
      <div class="wide"><span>Net salary</span><strong class="net-pay">${money(item.net_salary, item.currency)}</strong></div>
    </div>
    <h3 class="section-title">Calculation breakdown</h3>
    <div class="table-wrap compact"><table class="data-table"><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="2">No additional payroll components.</td></tr>'}</tbody></table></div>`;
  }

  function setLoading(message = 'Loading Adscope HRMS…') {
    app.innerHTML = `<div class="loading"><div><div class="spinner"></div>${esc(message)}</div></div>`;
  }

  function showModal(title, body, onSubmit) {
    modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal"><header class="modal-head"><h2>${esc(title)}</h2><button class="close" data-close>×</button></header><div class="modal-body">${body}</div></section></div>`;
    modalRoot.querySelector('[data-close]').onclick = closeModal;
    modalRoot.querySelector('.modal-backdrop').addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
    const form = modalRoot.querySelector('form');
    if (form && onSubmit) form.onsubmit = onSubmit;
  }
  function closeModal(){ modalRoot.innerHTML = ''; }

  function loginView(message = '') {
    app.innerHTML = `<main class="login-page"><section class="login-card">
      <div class="brand-row"><div class="brand-mark">A</div><div><div class="brand-title">Adscope HRMS</div><div class="brand-sub">Secure cloud administration</div></div></div>
      <h1>Sign in</h1><p>Use your authorized Adscope account.</p>
      ${message ? `<div class="notice error">${esc(message)}</div>` : ''}
      <form id="loginForm">
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary full" type="submit">Sign in</button>
      </form>
      <button class="link-btn" id="forgotPassword">Forgot password?</button>
    </section></main>`;
    document.getElementById('loginForm').onsubmit = async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const button = event.currentTarget.querySelector('button');
      button.disabled = true; button.textContent = 'Signing in…';
      const { error } = await client.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
      if (error) loginView(error.message);
    };
    document.getElementById('forgotPassword').onclick = () => {
      showModal('Reset password', `<form><label class="field"><span>Email</span><input name="email" type="email" required></label><div class="button-row"><button class="primary" type="submit">Send reset email</button><button class="ghost" type="button" data-cancel>Cancel</button></div></form>`, async e => {
        e.preventDefault();
        const email = new FormData(e.currentTarget).get('email');
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/admin/` });
        if (error) return toast(humanizeError(error), 'error');
        closeModal(); toast('Password reset email sent.', 'success');
      });
      modalRoot.querySelector('[data-cancel]').onclick = closeModal;
    };
  }

  async function loadContext() {
    const uid = state.session.user.id;
    const { data: memberships, error } = await client.from('organization_memberships')
      .select('id,organization_id,role,is_active,organizations(id,name,code,timezone)')
      .eq('user_id', uid).eq('is_active', true).limit(1);
    if (error) throw error;
    if (!memberships?.length) throw new Error('This account has no active Adscope HRMS role.');
    state.membership = memberships[0];
    state.organization = memberships[0].organizations;
  }

  function shell() {
    const [title, subtitle] = pageMeta[state.page];
    const nav = navItems.filter(item => item[2].includes(role())).map(([id,label]) => `<button data-page="${id}" class="${state.page===id?'active':''}">${label}</button>`).join('');
    app.innerHTML = `<div class="shell">
      <aside class="sidebar ${state.menuOpen?'open':''}" id="sidebar">
        <div class="brand-row"><div class="brand-mark">A</div><div><div class="brand-title">Adscope</div><div class="brand-sub">HRMS Cloud</div></div></div>
        <nav class="nav">${nav}</nav>
        <div class="side-bottom"><div class="user-name">${esc(state.session.user.email)}</div><div class="user-role">${esc(role().replace('_',' '))}</div><div class="button-row"><button class="ghost" id="attendancePortal">Attendance portal</button><button class="ghost" id="logout">Log out</button></div></div>
      </aside>
      <main class="main"><header class="topbar"><div class="button-row"><button class="ghost mobile-menu" id="menu">☰</button><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div></div><label class="month"><span>Active month</span><input id="activeMonth" type="month" value="${state.month}"></label></header><section class="content" id="content"><div class="panel"><div class="empty">Loading…</div></div></section></main>
    </div>`;
    app.querySelectorAll('[data-page]').forEach(btn => btn.onclick = () => { state.page = btn.dataset.page; state.menuOpen=false; render(); });
    document.getElementById('activeMonth').onchange = e => { state.month = e.target.value; loadPage(); };
    document.getElementById('logout').onclick = () => client.auth.signOut();
    document.getElementById('attendancePortal').onclick = () => window.open(cfg.employeePortalUrl, '_blank', 'noopener');
    document.getElementById('menu').onclick = () => document.getElementById('sidebar').classList.toggle('open');
  }

  async function render() {
    shell();
    await loadPage();
  }

  async function loadPage() {
    const content = document.getElementById('content');
    if (!content) return;
    content.innerHTML = `<div class="panel"><div class="empty"><div class="spinner"></div>Loading…</div></div>`;
    try {
      const loaders = { dashboard, employees, attendance, leaves, violations, payroll, policies, audit };
      await loaders[state.page](content);
    } catch (error) {
      console.error(error);
      content.innerHTML = `<div class="notice error"><strong>Could not load this page.</strong><p>${esc(humanizeError(error))}</p></div>`;
    }
  }

  async function dashboard(content) {
    const orgId = state.membership.organization_id;
    const [employeesR, attendanceR, leaveR, violationsR] = await Promise.all([
      client.from('employees').select('id,status', { count:'exact' }).eq('organization_id',orgId),
      client.from('attendance_days').select('id,status', { count:'exact' }).eq('organization_id',orgId).gte('attendance_date',startOfMonth()).lte('attendance_date',endOfMonth()),
      client.from('leave_requests').select('id,status', { count:'exact' }).eq('organization_id',orgId).eq('status','pending'),
      client.from('violations').select('id,workflow_status', { count:'exact' }).eq('organization_id',orgId).neq('workflow_status','final').neq('workflow_status','rejected')
    ]);
    [employeesR, attendanceR, leaveR, violationsR].forEach(r => { if (r.error) throw r.error; });
    const active = employeesR.data.filter(x => x.status === 'active').length;
    const late = attendanceR.data.filter(x => x.status === 'late').length;
    content.innerHTML = `<div class="stat-grid">
      <div class="stat"><div class="label">Active employees</div><div class="value">${active}</div><div class="note">${employeesR.count || 0} total records</div></div>
      <div class="stat"><div class="label">Attendance rows</div><div class="value">${attendanceR.count || 0}</div><div class="note">${late} late this month</div></div>
      <div class="stat"><div class="label">Pending leave requests</div><div class="value">${leaveR.count || 0}</div><div class="note">Require review</div></div>
      <div class="stat"><div class="label">Open violations</div><div class="value">${violationsR.count || 0}</div><div class="note">Not final or rejected</div></div>
    </div>
    <section class="panel"><header class="panel-head"><h2>System status</h2></header><div class="panel-body"><div class="notice success">Your account is connected and has <strong>${esc(role().replace('_',' '))}</strong> access to ${esc(state.organization.name)}.</div><p class="muted">All screens use the shared company database. Access is restricted by role, and every change is recorded.</p></div></section>`;
  }

  async function employees(content) {
    const { data, error } = await client.from('employees')
      .select('id,employee_code,full_name,email,position_title,status,employment_type,compensation_type,basic_salary,payroll_currency,attendance_required,portal_enabled,department_id,current_shift_id,department:departments(name),shift:shifts(name)')
      .eq('organization_id', state.membership.organization_id).order('employee_code');
    if (error) throw error;
    content.innerHTML = `<section class="panel"><header class="panel-head"><h2>Employee roster</h2><div class="button-row">${can('owner','hr_admin')?'<button class="primary" id="addEmployee">Add employee</button>':''}</div></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Employee</th><th>Department</th><th>Type</th><th>Shift</th><th>Status</th><th>Attendance</th><th>Portal</th>${can('owner','payroll_manager')?'<th>Salary</th>':''}<th></th></tr></thead><tbody>${data.map(e => `<tr>
      <td class="code">${esc(e.employee_code)}</td><td><strong>${esc(e.full_name)}</strong><br><span class="muted">${esc(e.email || e.position_title || '')}</span></td><td>${esc(e.department?.name || '—')}</td><td>${esc(e.employment_type.replace('_',' '))}</td><td>${esc(e.shift?.name || '—')}</td><td>${badge(e.status)}</td><td>${e.attendance_required?'<span class="badge gold">Required</span>':'<span class="badge gray">Exempt</span>'}</td><td>${e.portal_enabled?'<span class="badge green">Enabled</span>':'<span class="badge gray">Disabled</span>'}</td>${can('owner','payroll_manager')?`<td>${money(e.basic_salary,e.payroll_currency)}</td>`:''}<td><div class="table-actions">${can('owner','hr_admin')?`<button data-edit="${e.id}">Edit</button>`:''}</div></td></tr>`).join('')}</tbody></table></div></section>`;
    content.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => editEmployee(data.find(e => e.id === btn.dataset.edit)));
    if (document.getElementById('addEmployee')) document.getElementById('addEmployee').onclick = () => editEmployee(null);
  }

  async function editEmployee(employee) {
    const orgId = state.membership.organization_id;
    const [{ data: departments }, { data: shifts }] = await Promise.all([
      client.from('departments').select('id,name').eq('organization_id',orgId).eq('is_active',true).order('name'),
      client.from('shifts').select('id,name').eq('organization_id',orgId).eq('is_active',true).order('name')
    ]);
    const isNew = !employee;
    showModal(isNew?'Add employee':'Edit employee', `<form><div class="form-grid">
      <label class="field"><span>Employee code</span><input name="employee_code" value="${esc(employee?.employee_code || '')}" required ${isNew?'':'readonly'}></label>
      <label class="field"><span>Full name</span><input name="full_name" value="${esc(employee?.full_name || '')}" required></label>
      <label class="field"><span>Email</span><input name="email" type="email" value="${esc(employee?.email || '')}"></label>
      <label class="field"><span>Position</span><input name="position_title" value="${esc(employee?.position_title || '')}"></label>
      <label class="field"><span>Employment type</span><select name="employment_type">${options(['full_time','part_time','contract','intern','freelancer'],employee?.employment_type)}</select></label>
      <label class="field"><span>Status</span><select name="status">${options(['active','inactive','pending_setup','suspended','resigned'],employee?.status || 'pending_setup')}</select></label>
      <label class="field"><span>Department</span><select name="department_id"><option value="">None</option>${departments.map(d=>`<option value="${d.id}" ${employee?.department_id===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Assigned shift</span><select name="current_shift_id"><option value="">None</option>${shifts.map(s=>`<option value="${s.id}" ${employee?.current_shift_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Attendance requirement</span><select name="attendance_required">${options(['true','false'],String(employee?.attendance_required ?? true), {'true':'Required','false':'Exempt'})}</select></label>
      <label class="field"><span>Attendance portal</span><select name="portal_enabled">${options(['true','false'],String(employee?.portal_enabled ?? false), {'true':'Enabled','false':'Disabled'})}</select></label>
      ${can('owner','payroll_manager')?`<label class="field"><span>Monthly salary</span><input name="basic_salary" type="number" min="0" step="0.01" value="${esc(employee?.basic_salary || 0)}"></label><label class="field"><span>Currency</span><select name="payroll_currency">${options(['EGP','USD','SAR','AED'],employee?.payroll_currency || 'EGP')}</select></label>`:''}
      <div class="wide button-row"><button class="primary" type="submit">Save employee</button><button class="ghost" type="button" data-cancel>Cancel</button></div>
    </div></form>`, async event => {
      event.preventDefault(); const fd = new FormData(event.currentTarget);
      const payload = {
        organization_id: orgId, employee_code: fd.get('employee_code'), full_name: fd.get('full_name'), email: fd.get('email') || null,
        position_title: fd.get('position_title') || null, employment_type: fd.get('employment_type'), status: fd.get('status'),
        department_id: fd.get('department_id') || null, current_shift_id: fd.get('current_shift_id') || null,
        attendance_required: fd.get('attendance_required') === 'true', portal_enabled: fd.get('portal_enabled') === 'true'
      };
      let saved;
      if (isNew) {
        const { data, error } = await client.from('employees').insert(payload).select('id').single(); if (error) return toast(humanizeError(error),'error'); saved=data;
      } else {
        const { error } = await client.from('employees').update(payload).eq('id',employee.id); if (error) return toast(humanizeError(error),'error'); saved={id:employee.id};
      }
      const selectedShift = fd.get('current_shift_id') || null;
      if (selectedShift && (isNew || selectedShift !== employee?.current_shift_id)) {
        const { error } = await client.rpc('assign_employee_shift', {
          p_employee_id: saved.id, p_shift_id: selectedShift, p_effective_from: startOfMonth(), p_reason: 'Assigned through HRMS Cloud'
        });
        if (error) return toast(`Employee saved, but shift history failed: ${error.message}`,'error');
      }
      if (can('owner','payroll_manager') && fd.has('basic_salary')) {
        const { error } = await client.rpc('set_employee_compensation', {
          p_employee_id: saved.id, p_compensation_type: employee?.compensation_type || 'fixed_salary',
          p_basic_salary: Number(fd.get('basic_salary')||0), p_currency: fd.get('payroll_currency'), p_default_commission_rate: 0,
          p_attendance_required: fd.get('attendance_required') === 'true', p_effective_from: startOfMonth(), p_reason: 'Updated through HRMS Cloud'
        });
        if (error) return toast(`Employee saved, but compensation failed: ${error.message}`,'error');
      }
      closeModal(); toast('Employee saved.','success'); loadPage();
    });
    modalRoot.querySelector('[data-cancel]').onclick = closeModal;
  }

  async function attendance(content) {
    const orgId = state.membership.organization_id;
    const { data, error } = await client.from('attendance_days')
      .select('id,attendance_date,status,status_override,scheduled_workday,scheduled_start,scheduled_end,check_in_at,check_out_at,raw_late_minutes,deductible_late_minutes,notice_provided,late_approval,overtime_minutes,approved_overtime_minutes,overtime_approval,employee:employees(id,employee_code,full_name),shift:shifts(name)')
      .eq('organization_id',orgId).gte('attendance_date',startOfMonth()).lte('attendance_date',endOfMonth()).order('attendance_date').order('employee_id');
    if (error) throw error;
    content.innerHTML = `<div class="button-row" style="margin-bottom:14px">${can('owner','hr_admin')?'<button class="primary" id="generateAttendance">Generate attendance month</button>':''}<span class="muted">${data.length} attendance records</span></div><section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Employee</th><th>Shift</th><th>Check in</th><th>Check out</th><th>Late</th><th>Status</th><th>Notice</th><th></th></tr></thead><tbody>${data.map(d=>`<tr><td>${esc(d.attendance_date)}</td><td><strong>${esc(d.employee?.full_name||'—')}</strong><br><span class="code">${esc(d.employee?.employee_code||'')}</span></td><td>${esc(d.shift?.name||'—')}</td><td>${timeFmt(d.check_in_at)}</td><td>${timeFmt(d.check_out_at)}</td><td>${d.raw_late_minutes||0} min</td><td>${badge(d.status_override||d.status)}</td><td>${d.notice_provided?'Yes':'No'}</td><td><div class="table-actions">${can('owner','hr_admin')?`<button data-edit-att="${d.id}">Review</button>`:''}</div></td></tr>`).join('')}</tbody></table>${data.length?'':'<div class="empty">No rows yet. Generate the month first.</div>'}</div></section>`;
    if (document.getElementById('generateAttendance')) document.getElementById('generateAttendance').onclick = async () => {
      const { data, error } = await client.rpc('generate_attendance_month',{p_month_start:startOfMonth()});
      if (error) return toast(humanizeError(error),'error'); toast(data?.created ? `${data.created} attendance records created.` : 'Attendance schedule is already up to date.','success'); loadPage();
    };
    content.querySelectorAll('[data-edit-att]').forEach(btn => btn.onclick = () => editAttendance(data.find(d=>d.id===btn.dataset.editAtt)));
  }

  function editAttendance(day) {
    showModal('Review attendance', `<form><div class="form-grid">
      <div class="wide notice">${esc(day.employee?.full_name)} — ${esc(day.attendance_date)} — ${esc(day.shift?.name||'No shift')}</div>
      <label class="field"><span>Status override</span><select name="status_override"><option value="">Automatic</option>${options(['present','late','absent','leave','permission','missing_checkout','holiday','weekend','invalid'],day.status_override)}</select></label>
      <label class="field"><span>Notice provided</span><select name="notice_provided">${options(['true','false'],String(day.notice_provided),{'true':'Yes','false':'No'})}</select></label>
      <label class="field"><span>Late approval</span><select name="late_approval">${options(['none','pending','approved','rejected'],day.late_approval)}</select></label>
      <label class="field"><span>Overtime approval</span><select name="overtime_approval">${options(['none','pending','approved','rejected'],day.overtime_approval)}</select></label>
      <div class="wide button-row"><button class="primary" type="submit">Save review</button><button class="ghost" data-cancel type="button">Cancel</button></div>
    </div></form>`, async e => {
      e.preventDefault(); const fd=new FormData(e.currentTarget);
      const { error } = await client.from('attendance_days').update({ status_override:fd.get('status_override')||null, notice_provided:fd.get('notice_provided')==='true', late_approval:fd.get('late_approval'), overtime_approval:fd.get('overtime_approval') }).eq('id',day.id);
      if(error)return toast(humanizeError(error),'error'); closeModal();toast('Attendance review saved. Regenerate payroll after changes.','success');loadPage();
    });
    modalRoot.querySelector('[data-cancel]').onclick=closeModal;
  }

  async function leaves(content) {
    const { data, error } = await client.from('leave_requests').select('id,leave_code,start_date,end_date,requested_days,status,reason,decision_notes,employee:employees(full_name,employee_code),type:leave_types(name,is_paid)').eq('organization_id',state.membership.organization_id).order('start_date',{ascending:false});
    if(error)throw error;
    content.innerHTML=`<section class="panel"><header class="panel-head"><h2>Leave requests</h2></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>${data.map(l=>`<tr><td class="code">${esc(l.leave_code)}</td><td>${esc(l.employee?.full_name||'—')}</td><td>${esc(l.type?.name||'—')} ${l.type?.is_paid?'<span class="badge green">Paid</span>':''}</td><td>${esc(l.start_date)} → ${esc(l.end_date)}</td><td>${esc(l.requested_days||'—')}</td><td>${badge(l.status)}</td><td>${esc(l.reason||'')}</td><td><div class="table-actions">${l.status==='pending'&&can('owner','hr_admin')?`<button data-leave="${l.id}" data-decision="approve">Approve</button><button data-leave="${l.id}" data-decision="reject">Reject</button>`:''}</div></td></tr>`).join('')}</tbody></table>${data.length?'':'<div class="empty">No leave requests.</div>'}</div></section>`;
    content.querySelectorAll('[data-leave]').forEach(btn=>btn.onclick=async()=>{
      const {error}=await client.rpc('decide_leave_request',{p_leave_id:btn.dataset.leave,p_approve:btn.dataset.decision==='approve',p_notes:`Decision through HRMS Cloud by ${state.session.user.email}`});
      if(error)return toast(humanizeError(error),'error');toast('Leave decision saved.','success');loadPage();
    });
  }

  async function violations(content) {
    const orgId=state.membership.organization_id;
    const [{data,error},{data:employeesData},{data:typesData}] = await Promise.all([
      client.from('violations').select('id,violation_code,violation_date,description,workflow_status,appeal_status,final_occurrence_number,final_penalty_fraction,final_action_text,employee:employees(full_name,employee_code),type:violation_types(name_en,name_ar)').eq('organization_id',orgId).order('violation_date',{ascending:false}),
      client.from('employees').select('id,full_name,employee_code').eq('organization_id',orgId).eq('status','active').order('full_name'),
      client.from('violation_types').select('id,code,name_en,name_ar').eq('organization_id',orgId).eq('is_active',true).order('name_en')
    ]);
    if(error)throw error;
    content.innerHTML=`<div class="button-row" style="margin-bottom:14px">${can('owner','hr_admin')?'<button class="primary" id="addViolation">Record violation</button>':''}</div><section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Code</th><th>Employee</th><th>Type</th><th>Status</th><th>Occurrence</th><th>Payroll action</th><th></th></tr></thead><tbody>${data.map(v=>`<tr><td>${esc(v.violation_date)}</td><td class="code">${esc(v.violation_code)}</td><td>${esc(v.employee?.full_name||'Company-wide')}</td><td>${esc(v.type?.name_en||v.type?.name_ar||'—')}</td><td>${badge(v.workflow_status)}</td><td>${esc(v.final_occurrence_number||'—')}</td><td>${esc(v.final_action_text||'Not final')}</td><td><div class="table-actions">${v.workflow_status!=='final'&&v.workflow_status!=='rejected'&&can('owner','hr_admin')?`<button data-finalize="${v.id}">Finalize</button>`:''}</div></td></tr>`).join('')}</tbody></table>${data.length?'':'<div class="empty">No violations recorded.</div>'}</div></section>`;
    if(document.getElementById('addViolation'))document.getElementById('addViolation').onclick=()=>{
      showModal('Record violation',`<form><div class="form-grid"><label class="field"><span>Employee</span><select name="employee_id" required><option value="">Select employee</option>${employeesData.map(e=>`<option value="${e.id}">${esc(e.full_name)} (${esc(e.employee_code)})</option>`).join('')}</select></label><label class="field"><span>Violation type</span><select name="violation_type_id" required><option value="">Select type</option>${typesData.map(t=>`<option value="${t.id}">${esc(t.name_en)}</option>`).join('')}</select></label><label class="field"><span>Date</span><input name="violation_date" type="date" value="${new Date().toISOString().slice(0,10)}" required></label><label class="field wide"><span>Description</span><textarea name="description" required></textarea></label><div class="wide button-row"><button class="primary" type="submit">Save draft</button><button class="ghost" type="button" data-cancel>Cancel</button></div></div></form>`,async e=>{
        e.preventDefault();const fd=new FormData(e.currentTarget);const payload={organization_id:orgId,employee_id:fd.get('employee_id'),violation_type_id:fd.get('violation_type_id'),violation_date:fd.get('violation_date'),description:fd.get('description'),violation_code:`V-${Date.now()}`,workflow_status:'draft',created_by:state.session.user.id};
        const{error}=await client.from('violations').insert(payload);if(error)return toast(humanizeError(error),'error');closeModal();toast('Violation saved as draft.','success');loadPage();
      });modalRoot.querySelector('[data-cancel]').onclick=closeModal;
    };
    content.querySelectorAll('[data-finalize]').forEach(btn=>btn.onclick=async()=>{if(!confirm('Finalize this violation and apply its policy action to payroll?'))return;const{data,error}=await client.rpc('finalize_violation',{p_violation_id:btn.dataset.finalize,p_reason:'Finalized through HRMS Cloud'});if(error)return toast(humanizeError(error),'error');toast('Violation finalized. Its approved payroll action will be applied where relevant.','success');loadPage();});
  }

  async function payroll(content) {
    if(!can('owner','payroll_manager')) throw new Error('Payroll is restricted to the Owner and Payroll Manager roles.');
    const orgId=state.membership.organization_id;
    let {data:period,error}=await client.from('payroll_periods').select('*').eq('organization_id',orgId).eq('month_start',startOfMonth()).maybeSingle();if(error)throw error;
    if(!period){const created=await client.from('payroll_periods').insert({organization_id:orgId,month_start:startOfMonth(),month_end:endOfMonth(),status:'open'}).select('*').single();if(created.error)throw created.error;period=created.data;}
    const {data:runs,error:runsError}=await client.from('payroll_runs').select('*').eq('payroll_period_id',period.id).order('generation_number',{ascending:false});if(runsError)throw runsError;
    const latest=runs?.[0]||null;let items=[];if(latest){const res=await client.from('payroll_items').select('*,components:payroll_components(*)').eq('payroll_run_id',latest.id).order('employee_code');if(res.error)throw res.error;items=res.data||[];}
    content.innerHTML=`<section class="panel"><header class="panel-head"><h2>${esc(state.month)} payroll</h2><span>${badge(period.status)}</span></header><div class="panel-body"><div class="button-row"><button class="secondary" id="genAtt">Prepare attendance month</button><button class="secondary" id="preflight">Check payroll readiness</button><button class="secondary" id="closeAtt">Lock attendance</button><button class="primary" id="genPayroll">Generate payroll</button>${latest&&latest.status==='calculated'?'<button class="secondary" data-advance="reviewed">Mark as reviewed</button>':''}${latest&&latest.status==='reviewed'&&can('owner')?'<button class="primary" data-advance="approved">Approve</button>':''}${latest&&latest.status==='approved'?'<button class="secondary" data-advance="paid">Mark paid</button>':''}${latest&&latest.status==='paid'?'<button class="secondary" data-advance="locked">Lock</button>':''}</div><div id="payrollMessage" style="margin-top:14px"></div></div></section>
      <section class="panel"><header class="panel-head"><h2>Latest payroll calculation</h2><span class="muted">${latest?`Calculation ${latest.generation_number} — ${esc(latest.status)}`:'Not generated'}</span></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Employee</th><th>Scheduled days</th><th>Daily rate</th><th>Additions</th><th>Deductions</th><th>Net</th><th></th></tr></thead><tbody>${items.map(i=>`<tr><td><strong>${esc(i.employee_name)}</strong><br><span class="code">${esc(i.employee_code)}</span></td><td>${i.scheduled_service_days}</td><td>${money(i.daily_rate,i.currency)}</td><td>${money(i.total_additions,i.currency)}</td><td>${money(i.total_deductions,i.currency)}</td><td><strong>${money(i.net_salary,i.currency)}</strong></td><td><div class="table-actions"><button data-trace="${i.id}">View details</button></div></td></tr>`).join('')}</tbody></table>${items.length?'':'<div class="empty">No payroll items yet.</div>'}</div></section>`;
    const msg=document.getElementById('payrollMessage');
    document.getElementById('genAtt').onclick=async()=>actionRpc('generate_attendance_month',{p_month_start:startOfMonth()},msg,'Attendance month generated');
    document.getElementById('preflight').onclick=async()=>actionRpc('payroll_preflight',{p_period_id:period.id},msg,'Preflight completed',false);
    document.getElementById('closeAtt').onclick=async()=>actionRpc('close_attendance_period',{p_period_id:period.id},msg,'Attendance closed');
    document.getElementById('genPayroll').onclick=async()=>actionRpc('generate_payroll',{p_period_id:period.id},msg,'Payroll generated');
    content.querySelectorAll('[data-advance]').forEach(btn=>btn.onclick=async()=>actionRpc('advance_payroll_status',{p_run_id:latest.id,p_target:btn.dataset.advance},msg,`Payroll marked ${btn.dataset.advance}`));
    content.querySelectorAll('[data-trace]').forEach(btn=>btn.onclick=()=>{const item=items.find(i=>i.id===btn.dataset.trace);showModal(`Payroll details — ${item.employee_name}`,renderPayrollDetails(item));});
  }

  async function actionRpc(name,args,msg,success,refresh=true){
    msg.innerHTML='<div class="notice"><strong>Working…</strong><p>Please wait while the system completes this step.</p></div>';
    const{data,error}=await client.rpc(name,args);
    if(error){msg.innerHTML=`<div class="notice error"><strong>Action could not be completed</strong><p>${esc(humanizeError(error))}</p></div>`;return;}
    msg.innerHTML=payrollActionMessage(name,data,args);
    if(refresh)setTimeout(loadPage,1200);
  }

  async function policies(content){
    const orgId=state.membership.organization_id;const[{data:versions,error},{data:clauses},{data:types}]=await Promise.all([client.from('policy_versions').select('*').eq('organization_id',orgId).order('effective_from',{ascending:false}),client.from('policy_clauses').select('*').eq('organization_id',orgId).eq('is_active',true).order('sort_order'),client.from('violation_types').select('*').eq('organization_id',orgId).order('name_en')]);if(error)throw error;
    content.innerHTML=`<section class="panel"><header class="panel-head"><h2>Active handbook</h2></header><div class="panel-body">${versions.map(v=>`<div class="notice ${v.is_active?'success':''}"><strong>${esc(v.name)} — v${esc(v.version_code)}</strong><br>Effective ${esc(v.effective_from)} ${v.is_active?'— Active':''}</div>`).join('')}</div></section><section class="panel"><header class="panel-head"><h2>Policy clauses (${clauses.length})</h2></header><div class="panel-body">${clauses.map(c=>`<details style="padding:10px 0;border-bottom:1px solid #29435e"><summary><strong>${esc(c.section_number)} — ${esc(c.title)}</strong></summary><p class="muted">${esc(c.content_ar)}</p></details>`).join('')}</div></section><section class="panel"><header class="panel-head"><h2>Violation matrix</h2></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Window</th><th>Penalty fractions</th><th>Actions</th></tr></thead><tbody>${types.map(t=>`<tr><td><strong>${esc(t.name_en)}</strong><br><span class="muted">${esc(t.name_ar)}</span></td><td>${t.recurrence_window_days} days</td><td>${esc(formatPenaltyFractions(t.penalty_fractions))}</td><td>${esc(t.action_texts.join(' → '))}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  async function audit(content){
    const{data,error}=await client.from('audit_logs').select('*').eq('organization_id',state.membership.organization_id).order('created_at',{ascending:false}).limit(250);if(error)throw error;
    content.innerHTML=`<section class="panel"><header class="panel-head"><h2>Latest 250 audit events</h2></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead><tbody>${data.map(a=>`<tr><td>${dateFmt(a.created_at)} ${timeFmt(a.created_at)}</td><td>${esc(a.actor_role||'system')}</td><td>${esc(a.action)}</td><td>${esc(a.entity_type)}<br><span class="code">${esc(a.entity_id)}</span></td><td>${esc(a.reason||'')}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  function badge(value){const v=String(value||'unknown');const kind=/active|approved|present|paid|locked|final|completed/i.test(v)?'green':/rejected|absent|invalid|suspended/i.test(v)?'red':/pending|late|open|review|calculated/i.test(v)?'gold':'gray';return `<span class="badge ${kind}">${esc(v.replaceAll('_',' '))}</span>`;}
  function options(values,selected,labels={}){return values.map(v=>`<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(labels[v]||String(v).replaceAll('_',' '))}</option>`).join('');}

  async function boot(){
    setLoading();
    const { data:{session} } = await client.auth.getSession();
    state.session=session;
    if(!session)return loginView();
    try{await loadContext();await render();}catch(error){initializationErrorView(error);}
  }

  let booting=null;
  function bootOnce(){
    if(booting)return booting;
    booting=boot().finally(()=>{booting=null;});
    return booting;
  }

  function initializationErrorView(error){
    app.innerHTML=`<main class="login-page"><section class="login-card" role="alert"><h1>Unable to open the dashboard</h1><p>${esc(humanizeError(error))}</p><div class="button-row"><button class="primary" id="retryInitialization">Retry</button><button class="ghost" id="initializationLogout">Log out</button></div></section></main>`;
    document.getElementById('retryInitialization').onclick=()=>bootOnce();
    document.getElementById('initializationLogout').onclick=()=>client.auth.signOut();
  }

  client.auth.onAuthStateChange((event,session)=>{
    window.setTimeout(async()=>{
      const previousUserId=state.session?.user?.id;
      state.session=session;
      if(event==='SIGNED_OUT'||!session)return loginView();
      if(event==='PASSWORD_RECOVERY'){
        showModal('Set a new password',`<form><label class="field"><span>New password</span><input name="password" type="password" minlength="8" required></label><button class="primary" type="submit">Update password</button></form>`,async e=>{e.preventDefault();const{error}=await client.auth.updateUser({password:new FormData(e.currentTarget).get('password')});if(error)return toast(humanizeError(error),'error');closeModal();toast('Password updated.','success');});
        return;
      }
      if(previousUserId===session.user.id&&state.membership)return;
      try{await bootOnce();}catch(error){initializationErrorView(error);}
    },0);
  });

  bootOnce();
})();

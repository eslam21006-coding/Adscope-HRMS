import vm from 'node:vm';

export default async function handler(req, res) {
  try {
    const base = `https://${req.headers.host}`;
    const [portalResponse, pageResponse, stylesResponse] = await Promise.all([
      fetch(`${base}/attendance/portal.js`, { cache:'no-store' }),
      fetch(`${base}/attendance/`, { cache:'no-store' }),
      fetch(`${base}/attendance/styles.css`, { cache:'no-store' })
    ]);
    if (!portalResponse.ok || !pageResponse.ok || !stylesResponse.ok) throw new Error('Portal assets are not all reachable');
    const [portal, page, styles] = await Promise.all([portalResponse.text(), pageResponse.text(), stylesResponse.text()]);
    new vm.Script(portal, { filename:'portal.js' });
    const required = ['Home','Attendance','Requests','Leave','Salary Advances','Violations','Notifications','Profile'];
    const missing = required.filter(label => !portal.includes(label));
    const checks = {
      syntax: true,
      fullNavigation: missing.length === 0,
      directSource: page.includes('/attendance/portal.js') && !page.includes('hrms-static-assets?bundle=attendance'),
      timeout: portal.includes('REQUEST_TIMEOUT_MS = 15000'),
      attendanceState: portal.includes("client.rpc('get_my_attendance_state')"),
      attendanceAction: portal.includes("client.functions.invoke('attendance-event'"),
      responsiveWorkspace: styles.includes('.workspace') && styles.includes('.mobile-nav'),
      requestSubmission: portal.includes('submit_permission_request') && portal.includes('submit_leave_request') && portal.includes('submit_advance_request')
    };
    res.setHeader('Cache-Control','no-store');
    res.status(Object.values(checks).every(Boolean) ? 200 : 500).json({ checks, missing, portalBytes:portal.length, styleBytes:styles.length });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Portal validation failed', stack: error instanceof Error ? error.stack : null });
  }
}

export default async function handler(req, res) {
  try {
    const url = 'https://fazvuuwgahuxacvgyslf.supabase.co/rest/v1/';
    const key = 'sb_publishable_F7S5nEal7qghrczR7v0k8A_6GEPMbDq';
    const response = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/openapi+json'
      }
    });
    if (!response.ok) {
      res.status(response.status).json({ ok: false, status: response.status });
      return;
    }
    const schema = await response.json();
    const names = ['submit_permission_request', 'submit_leave_request', 'submit_advance_request', 'submit_violation_response'];
    const result = {};
    for (const name of names) {
      const path = schema.paths?.[`/rpc/${name}`] || null;
      result[name] = path ? { post: path.post || null, get: path.get || null } : null;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Diagnostic request failed' });
  }
}

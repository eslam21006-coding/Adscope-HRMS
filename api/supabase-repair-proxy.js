export default async function handler(req, res) {
  const token = String(req.query?.t || '');
  const dry = String(req.query?.dry || '') === '1';
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const url = new URL('https://fazvuuwgahuxacvgyslf.supabase.co/functions/v1/attendance-bundle-bootstrap');
  url.searchParams.set('token', token);
  if (dry) url.searchParams.set('dry_run', '1');
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();
  res.setHeader('cache-control', 'no-store');
  res.status(response.status).send(text);
}

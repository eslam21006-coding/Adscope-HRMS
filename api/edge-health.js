import { gunzipSync } from 'node:zlib';

export default async function handler(req, res) {
  const base = 'https://fazvuuwgahuxacvgyslf.supabase.co/functions/v1';
  const timeoutMs = 10000;
  async function probe(name, url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      return { name, status: response.status, ok: response.ok, ms: Date.now() - started, length: text.length, body: text.slice(0, 300) };
    } catch (error) {
      return { name, status: 0, ok: false, ms: Date.now() - started, error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  const [adminAsset, portalBundle, attendanceEvent] = await Promise.all([
    probe('admin-asset', `${base}/hrms-static-assets?file=admin.js`),
    probe('employee-portal-bundle', `${base}/hrms-static-assets?bundle=attendance`),
    probe('attendance-event-unauthenticated', `${base}/attendance-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start_shift' }),
    }),
  ]);

  if (portalBundle.ok && portalBundle.body) {
    try {
      const fullResponse = await fetch(`${base}/hrms-static-assets?bundle=attendance`);
      const encoded = await fullResponse.text();
      const html = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
      portalBundle.bundle = {
        decoded: true,
        htmlLength: html.length,
        hasRoot: /id=["'](?:app|portalApp)["']/i.test(html),
        hasNavigation: /data-page=/i.test(html),
        hasLayout: /portal-shell|class=["'][^"']*\bshell\b|<nav\b|class=["'][^"']*\bsidebar\b/i.test(html),
        hasEmployeeFeatures: /requests|leave|advance|notification|profile/i.test(html),
      };
      delete portalBundle.body;
    } catch (error) {
      portalBundle.bundle = { decoded: false, error: String(error?.message || error) };
    }
  }

  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({ checkedAt: new Date().toISOString(), adminAsset, portalBundle, attendanceEvent });
}

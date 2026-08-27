const SUPABASE_URL = 'https://fazvuuwgahuxacvgyslf.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_F7S5nEal7qghrczR7v0k8A_6GEPMbDq';

export default async function handler(req, res) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: PUBLISHABLE_KEY,
        Accept: 'application/openapi+json'
      },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`PostgREST returned ${response.status}`);
    const schema = await response.json();
    const words = ['employee','attendance','leave','request','advance','notification','violation','permission','correction','policy','profile'];
    const matches = value => words.some(word => String(value).toLowerCase().includes(word));
    const definitions = {};
    for (const [name, def] of Object.entries(schema.definitions || {})) {
      if (!matches(name)) continue;
      definitions[name] = Object.fromEntries(Object.entries(def.properties || {}).map(([key, value]) => [key, {
        type: value.type || null,
        format: value.format || null,
        description: value.description || null,
        enum: value.enum || null
      }]));
    }
    const paths = Object.keys(schema.paths || {}).filter(path => matches(path));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ definitions, paths });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Schema inspection failed' });
  }
}

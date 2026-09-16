const supabaseUrl = 'https://fazvuuwgahuxacvgyslf.supabase.co';
const key = 'sb_publishable_F7S5nEal7qghrczR7v0k8A_6GEPMbDq';
const response = await fetch(`${supabaseUrl}/rest/v1/`, {
  headers: {
    apikey: key,
    Accept: 'application/openapi+json'
  }
});
console.log('OpenAPI status:', response.status);
if (!response.ok) throw new Error(`OpenAPI request failed: ${response.status}`);
const schema = await response.json();
for (const name of ['submit_permission_request','submit_leave_request','submit_advance_request','submit_violation_response']) {
  console.log(`\n===== ${name} =====`);
  const path = schema.paths?.[`/rpc/${name}`];
  console.log(path ? JSON.stringify(path, null, 2) : 'NOT FOUND');
}

// Short-lived credentials for Cloudflare's TURN relay, for the game's remote play
// (net.js fetches them before a connection is made). Only the game's own origins are
// answered, so the relay's quota is not anyone's to spend; the credentials last two
// hours and a browser may keep them for one. Deploy with `npx wrangler deploy` from
// this directory, after `npx wrangler secret put TURN_KEY_SECRET`.
const ORIGINS = [/^https:\/\/sokrypton\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const TTL = 2 * 3600;
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ORIGINS.some(re => re.test(origin));
    const cors = { 'Access-Control-Allow-Origin': allowed ? origin : 'null', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors, ...extra } });
    if (!allowed) return json({ error: 'not for this origin' }, 403);
    if (!env.TURN_KEY_SECRET) return json({ error: 'TURN_KEY_SECRET is not configured' }, 500);
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.TURN_KEY_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL }),
      });
      if (!res.ok) return json({ error: 'Cloudflare did not issue credentials', detail: await res.text() }, res.status);
      return json(await res.json(), 200, { 'Cache-Control': `private, max-age=${TTL / 2}` });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

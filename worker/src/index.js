export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      const turnKeyId = env.TURN_KEY_ID || 'f02778d425cae4ac79ad38054cbe2555';
      const turnKeySecret = env.TURN_KEY_SECRET;
      if (!turnKeySecret) {
        return new Response(JSON.stringify({ error: 'TURN_KEY_SECRET is not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${turnKeySecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }), // 24 hours
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: 'Failed to generate ICE servers', detail: errText }), {
          status: res.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600', // Cache at Cloudflare edge for 1 hour
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};

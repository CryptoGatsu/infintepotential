/**
 * Shared state for Infinite Potential.
 *
 *   GET  /api/state              -> { ceiling, ath, configured: true }
 *   POST /api/state  {"action":"break"}            -> { ceiling }
 *   POST /api/state  {"action":"ath","value":1234} -> { ath }
 *
 * Storage is any Redis with an Upstash style REST endpoint. On Vercel, add the
 * Upstash for Redis integration and it injects the two variables below on its
 * own. No npm packages, no build step, nothing to install.
 *
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *
 * If those are missing the endpoint answers 501 and the site quietly falls back
 * to per device storage, so the page never breaks.
 */

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const CEILING_KEY = 'ip:ceiling';
const ATH_KEY = 'ip:ath';

const RATE_WINDOW = 10;   // seconds
const RATE_MAX = 20;      // requests per window per address

async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + KV_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error('kv error ' + res.status);
  const json = await res.json();
  return json.result;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!KV_URL || !KV_TOKEN) {
    res.status(501).json({ configured: false, reason: 'KV env vars not set' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const values = await kv(['MGET', CEILING_KEY, ATH_KEY]);
      res.status(200).json({
        configured: true,
        ceiling: num(values && values[0]),
        ath: num(values && values[1])
      });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    // light throttle so nobody scripts the counter into the millions in a minute
    const fwd = req.headers['x-forwarded-for'] || '';
    const addr = String(fwd).split(',')[0].trim() || 'anon';
    const rateKey = 'ip:rate:' + addr;
    const hits = await kv(['INCR', rateKey]);
    if (hits === 1) await kv(['EXPIRE', rateKey, RATE_WINDOW]);
    if (hits > RATE_MAX) {
      res.status(429).json({ error: 'slow down' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    if (body.action === 'break') {
      const ceiling = await kv(['INCR', CEILING_KEY]);
      res.status(200).json({ configured: true, ceiling: num(ceiling) });
      return;
    }

    if (body.action === 'ath') {
      const value = Number(body.value);
      if (!Number.isFinite(value) || value <= 0 || value > 1e15) {
        res.status(400).json({ error: 'bad value' });
        return;
      }
      const current = num(await kv(['GET', ATH_KEY]));
      if (value > current) {
        await kv(['SET', ATH_KEY, String(Math.round(value))]);
        res.status(200).json({ configured: true, ath: Math.round(value) });
        return;
      }
      res.status(200).json({ configured: true, ath: current });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    res.status(500).json({ error: 'state unavailable' });
  }
}

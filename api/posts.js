/**
 * Community post board for Infinite Potential.
 *
 * Public
 *   GET  /api/posts?view=top&offset=0&limit=5   -> { posts, total }
 *   GET  /api/posts?view=new&offset=0&limit=5   -> { posts, total }
 *   POST /api/posts {"action":"submit","url":"https://x.com/...","wallet":"0x..."}
 *   POST /api/posts {"action":"vote","id":"12","dir":"up"}
 *
 * Admin, requires header  x-admin-key: <ADMIN_KEY>
 *   GET  /api/posts?view=admin                  -> every post, newest first
 *   GET  /api/posts?view=selected               -> the payout queue
 *   POST /api/posts {"action":"remove","id":"12"}
 *   POST /api/posts {"action":"select","id":"12"}
 *   POST /api/posts {"action":"unselect","id":"12"}
 *   POST /api/posts {"action":"paid","id":"12","amount":"250000"}
 *
 * Environment
 *   KV_REST_API_URL     injected by the Upstash for Redis integration
 *   KV_REST_API_TOKEN   injected by the Upstash for Redis integration
 *   ADMIN_KEY           any long random string you choose
 */

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;

const K = {
  seq: 'ip:posts:seq',
  top: 'ip:posts:top',        // sorted set, score = net votes
  fresh: 'ip:posts:new',      // sorted set, score = created timestamp
  selected: 'ip:posts:selected',
  post: (id) => 'ip:post:' + id,
  voted: (id, who) => 'ip:voted:' + id + ':' + who,
  subRate: (who) => 'ip:subrate:' + who,
  voteRate: (who) => 'ip:voterate:' + who
};

const PAGE_MAX = 20;
const SUBMIT_PER_HOUR = 5;
const VOTES_PER_MINUTE = 30;

const URL_RE = /^https:\/\/(x\.com|twitter\.com)\/[A-Za-z0-9_]{1,20}\/status\/\d{5,25}(\?.*)?$/;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error('kv error ' + res.status);
  const json = await res.json();
  return json.result;
}

function who(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim().replace(/[^a-zA-Z0-9.:]/g, '') || 'anon';
}

function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const key = req.headers['x-admin-key'];
  return typeof key === 'string' && key.length > 0 && key === ADMIN_KEY;
}

function cleanUrl(raw) {
  const url = String(raw || '').trim().split('?')[0];
  if (!URL_RE.test(url)) return null;
  return url.replace('twitter.com', 'x.com');
}

function shortWallet(w) {
  return w.slice(0, 6) + '...' + w.slice(-4);
}

/* what the public sees: never the full wallet address */
function publicView(p) {
  return {
    id: p.id,
    url: p.url,
    handle: p.handle,
    wallet: shortWallet(p.wallet),
    up: p.up,
    down: p.down,
    score: p.up - p.down,
    created: p.created,
    selected: !!p.selected,
    paid: !!p.paid
  };
}

async function readPosts(ids) {
  if (!ids.length) return [];
  const raw = await kv(['MGET'].concat(ids.map(K.post)));
  const out = [];
  for (const item of raw || []) {
    if (!item) continue;
    try { out.push(JSON.parse(item)); } catch (e) {}
  }
  return out;
}

async function rate(key, limit, seconds) {
  const hits = await kv(['INCR', key]);
  if (hits === 1) await kv(['EXPIRE', key, seconds]);
  return hits <= limit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!KV_URL || !KV_TOKEN) {
    res.status(501).json({ configured: false, reason: 'KV env vars not set' });
    return;
  }

  try {
    if (req.method === 'GET') return await onGet(req, res);
    if (req.method === 'POST') return await onPost(req, res);
    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    res.status(500).json({ error: 'board unavailable' });
  }
}

async function onGet(req, res) {
  const q = req.query || {};
  const view = String(q.view || 'top');
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(q.limit, 10) || 5));

  if (view === 'admin' || view === 'selected') {
    if (!isAdmin(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    let ids;
    if (view === 'selected') {
      ids = (await kv(['SMEMBERS', K.selected])) || [];
    } else {
      ids = (await kv(['ZREVRANGE', K.fresh, 0, 199])) || [];
    }
    const posts = await readPosts(ids);
    posts.sort((a, b) => b.created - a.created);
    res.status(200).json({ configured: true, admin: true, posts, total: posts.length });
    return;
  }

  const zset = view === 'new' ? K.fresh : K.top;
  const total = (await kv(['ZCARD', zset])) || 0;
  const ids = (await kv(['ZREVRANGE', zset, offset, offset + limit - 1])) || [];
  const posts = await readPosts(ids);

  /* keep the order the sorted set gave us */
  const rank = new Map(ids.map((id, i) => [String(id), i]));
  posts.sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));

  res.status(200).json({
    configured: true,
    posts: posts.map(publicView),
    total: Number(total),
    offset,
    limit,
    view
  });
}

async function onPost(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const action = String(body.action || '');
  const admin = isAdmin(req);
  const addr = who(req);

  /* ---- admin actions ---- */
  if (['remove', 'select', 'unselect', 'paid'].includes(action)) {
    if (!admin) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const id = String(body.id || '').replace(/[^0-9]/g, '');
    if (!id) {
      res.status(400).json({ error: 'bad id' });
      return;
    }

    if (action === 'remove') {
      await kv(['ZREM', K.top, id]);
      await kv(['ZREM', K.fresh, id]);
      await kv(['SREM', K.selected, id]);
      await kv(['DEL', K.post(id)]);
      res.status(200).json({ ok: true, removed: id });
      return;
    }

    const raw = await kv(['GET', K.post(id)]);
    if (!raw) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const post = JSON.parse(raw);

    if (action === 'select') {
      post.selected = true;
      await kv(['SADD', K.selected, id]);
    } else if (action === 'unselect') {
      post.selected = false;
      await kv(['SREM', K.selected, id]);
    } else if (action === 'paid') {
      post.paid = true;
      post.paidAt = Date.now();
      post.amount = String(body.amount || '').slice(0, 32);
      post.selected = false;
      await kv(['SREM', K.selected, id]);
    }

    await kv(['SET', K.post(id), JSON.stringify(post)]);
    res.status(200).json({ ok: true, post });
    return;
  }

  /* ---- submit ---- */
  if (action === 'submit') {
    const url = cleanUrl(body.url);
    const wallet = String(body.wallet || '').trim();

    if (!url) {
      res.status(400).json({ error: 'Paste a link to a public X post, like https://x.com/name/status/123' });
      return;
    }
    if (!WALLET_RE.test(wallet)) {
      res.status(400).json({ error: 'That does not look like a wallet address. It should start with 0x and have 40 characters after it.' });
      return;
    }
    if (!(await rate(K.subRate(addr), SUBMIT_PER_HOUR, 3600))) {
      res.status(429).json({ error: 'You have submitted a few already. Try again in a bit.' });
      return;
    }

    /* one entry per post link */
    const dupeKey = 'ip:posturl:' + Buffer.from(url).toString('base64').replace(/=+$/, '');
    const fresh = await kv(['SET', dupeKey, '1', 'NX']);
    if (fresh !== 'OK') {
      res.status(409).json({ error: 'That post is already on the wall.' });
      return;
    }

    const id = String(await kv(['INCR', K.seq]));
    const handleMatch = url.match(/x\.com\/([A-Za-z0-9_]{1,20})\//);
    const post = {
      id,
      url,
      handle: handleMatch ? '@' + handleMatch[1] : '',
      wallet,
      up: 1,
      down: 0,
      created: Date.now(),
      selected: false,
      paid: false
    };

    await kv(['SET', K.post(id), JSON.stringify(post)]);
    await kv(['ZADD', K.fresh, post.created, id]);
    await kv(['ZADD', K.top, 1, id]);
    await kv(['SET', K.voted(id, addr), 'up']);

    res.status(200).json({ ok: true, post: publicView(post) });
    return;
  }

  /* ---- vote ---- */
  if (action === 'vote') {
    const id = String(body.id || '').replace(/[^0-9]/g, '');
    const dir = body.dir === 'down' ? 'down' : 'up';
    if (!id) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    if (!(await rate(K.voteRate(addr), VOTES_PER_MINUTE, 60))) {
      res.status(429).json({ error: 'Slow down a little.' });
      return;
    }

    const first = await kv(['SET', K.voted(id, addr), dir, 'NX']);
    if (first !== 'OK') {
      res.status(409).json({ error: 'You already voted on that one.' });
      return;
    }

    const raw = await kv(['GET', K.post(id)]);
    if (!raw) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const post = JSON.parse(raw);
    if (dir === 'up') post.up += 1; else post.down += 1;

    await kv(['SET', K.post(id), JSON.stringify(post)]);
    await kv(['ZADD', K.top, post.up - post.down, id]);

    res.status(200).json({ ok: true, post: publicView(post) });
    return;
  }

  res.status(400).json({ error: 'unknown action' });
}

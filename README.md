# Infinite Potential ($IP)

Single page site for the $IP token on Robinhood Chain, launched through Pons.

No framework, no build step, no npm install. It is one HTML file, one admin page, and two serverless functions. Drop it on Vercel and it runs.

---

## What is in here

| File | What it does |
|---|---|
| `index.html` | The whole public site. Markup, styles, and scripts in one file. |
| `admin.html` | Admin console, served at `/admin`. Review posts, queue payouts, mark them sent. |
| `api/state.js` | Shared ceiling counter and all time high market cap. |
| `api/posts.js` | The post wall. Submissions, voting, and admin actions. |
| `vercel.json` | Clean URLs, no-store on the API, noindex on `/admin`. |
| `banner.png` | Wide hero artwork. Also the social share image. |
| `figure.png` | Square artwork used in the About section. |
| `favicon.svg` `favicon.ico` `apple-touch-icon.png` `icon-192.png` `icon-512.png` | Icon set. |
| `site.webmanifest` | Android home screen icon and theme color. |
| `IP-image-prompts.md` | Prompt kit for generating on-brand images. Not deployed. |

Everything except the last file goes at the site root.

---

## Deploy

### 1. Push to a repo and import it on Vercel

No build command, no output directory, no framework preset. Vercel picks up `api/` as functions automatically.

### 2. Add storage

In the Vercel dashboard, go to Storage and add the **Upstash for Redis** integration. It injects these two variables on its own:

```
KV_REST_API_URL
KV_REST_API_TOKEN
```

### 3. Add your admin key

Settings, Environment Variables, add:

```
ADMIN_KEY = <a long random string>
```

This is the only thing protecting the remove button. Generate it, do not invent it:

```bash
openssl rand -hex 32
```

### 4. Replace the domain placeholder

Open `index.html` and find and replace every instance of:

```
https://REPLACE-WITH-YOUR-DOMAIN.com
```

That fixes the canonical URL, `og:url`, and both social preview images in one pass.

### 5. Redeploy

The wall opens, the ceiling goes global, and `/admin` unlocks with your key.

**Skipping step 2 does not break the site.** The API answers 501, the ceiling falls back to per device storage, and the wall shows "The wall opens once the board is connected". Everything else works normally.

---

## Configuration

One object at the bottom of `index.html`. Anything left blank hides its own UI rather than rendering a dead link.

```js
const CONFIG = {
  ticker:      "$IP",
  contract:    "0x95adC3AAd8825410921BcD6e5Ea3F39A3205387B",
  chain:       "robinhood",
  pair:        "0x905288de491967770caa5fcc70e3a6c7fe436f19",
  dexUrl:      "https://dexscreener.com/robinhood/0x905288...",
  ponsUrl:     "https://www.ponsfamily.com/launchpad/0x95adC3...",
  stateApi:    "/api/state",
  xUrl:        "https://x.com/iponrh",
  communityUrl:"https://x.com/i/communities/1980356612952129721",
  telegramUrl: ""
};
```

| Key | Effect if blank |
|---|---|
| `contract` | Hides the copy button, shows "Dropping at launch" |
| `chain` / `pair` | Hides the live market stats strip |
| `dexUrl` | Hides the Chart button |
| `ponsUrl` | Buy button becomes a scroll to Tokenomics instead of a link |
| `stateApi` | Skips the shared state entirely, uses per device storage |
| `xUrl` / `communityUrl` / `telegramUrl` | Removes that link from nav and footer |

---

## Live data

Market cap, 24 hour volume, and all time high market cap come from the DexScreener public API, refreshed every 45 seconds and again whenever the tab regains focus.

```
https://api.dexscreener.com/latest/dex/pairs/robinhood/<pair>
```

DexScreener does not expose all time high market cap, so the site tracks it itself. Each refresh posts the current figure to `/api/state` and the server keeps the maximum it has ever seen. **It starts accumulating from your first deploy**, so the sooner the site is live the more accurate that number is.

---

## API reference

Both functions return `501 {"configured": false}` when the KV variables are missing. The front end treats that as a signal to degrade, not as an error.

### `/api/state`

| Method | Body | Returns |
|---|---|---|
| `GET` | | `{ ceiling, ath }` |
| `POST` | `{"action":"break"}` | `{ ceiling }` incremented |
| `POST` | `{"action":"ath","value":8147}` | `{ ath }`, only raised if the value is higher |

### `/api/posts`

Public:

| Method | Query or body | Returns |
|---|---|---|
| `GET` | `?view=top&offset=0&limit=5` | `{ posts, total }` sorted by net votes |
| `GET` | `?view=new&offset=0&limit=5` | same, sorted by newest |
| `POST` | `{"action":"submit","url":"...","wallet":"0x..."}` | the created post |
| `POST` | `{"action":"vote","id":"12","dir":"up"}` | the updated post |

Admin, all requiring the header `x-admin-key: <ADMIN_KEY>`:

| Method | Query or body | Effect |
|---|---|---|
| `GET` | `?view=admin` | Every post, newest first, with full wallet addresses |
| `GET` | `?view=selected` | The payout queue only |
| `POST` | `{"action":"select","id":"12"}` | Add to the payout queue |
| `POST` | `{"action":"unselect","id":"12"}` | Remove from the queue |
| `POST` | `{"action":"paid","id":"12","amount":"250000"}` | Mark sent and clear from the queue |
| `POST` | `{"action":"remove","id":"12"}` | Delete the post for everyone |

**Public responses never contain a full wallet address.** They are truncated to `0x218C...646D`. Only the admin views return the complete address. Posting a full address next to a public X handle is a targeting risk, so this is deliberate and worth keeping.

---

## Using the admin console

Go to `/admin` and enter your `ADMIN_KEY`. It is held in `sessionStorage`, so it is gone when the tab closes. There is a Lock button to clear it manually.

Three tabs:

- **All posts** is everything not yet paid. Each row has Preview, Queue for payout, and Remove.
- **Payout queue** is what you have selected. This tab adds Copy wallet list (newline separated, ready for a batch sender), Copy as CSV (`wallet,score,handle,url`), and View queue for when clipboard access is blocked.
- **Already sent** is your record, including the amount you entered.

A normal round looks like: skim the queue with Preview, queue the ones worth rewarding, copy the wallet list, send the tokens from your wallet, then come back and Mark sent on each one.

Sending is manual and on purpose. Nothing on this site holds a private key or can move tokens.

---

## Data model

Everything lives in Redis under an `ip:` prefix.

```
ip:ceiling            integer, the shared ceiling
ip:ath                integer, highest market cap ever seen
ip:posts:seq          integer, post id counter
ip:posts:top          sorted set, member = post id, score = net votes
ip:posts:new          sorted set, member = post id, score = created timestamp
ip:posts:selected     set of post ids in the payout queue
ip:post:<id>          JSON blob for one post
ip:voted:<id>:<addr>  marks that an address already voted on a post
ip:posturl:<b64>      marks a post URL as already submitted
ip:rate:*             short lived throttle counters
```

To reset the wall in production, delete the keys matching `ip:post*`. To reset the ceiling, delete `ip:ceiling`.

---

## Abuse controls

The wall hands out tokens, so it is worth knowing what is already in place.

- Post URLs must match the real X status pattern. `twitter.com` links are normalised to `x.com`.
- Wallets must be a valid 40 character hex address.
- One entry per post link, enforced with an atomic `SET NX`.
- Five submissions per hour and thirty votes per minute per address.
- One vote per address per post. Submitting counts as your own upvote, so you cannot stack your own entry.
- Twenty state writes per ten seconds per address on the ceiling.

None of this stops a determined person with a proxy pool. It stops casual spam. Final judgement is yours in the admin console, which is why Remove exists.

---

## Local development

The API functions need the Vercel runtime:

```bash
npx vercel dev
```

For pure front end work, any static server will do. The wall will show as not connected, which is the correct fallback behaviour:

```bash
python3 -m http.server 8000
```

---

## Customising

**Colours** are CSS custom properties at the top of each file. `--signal` is the main green, `--void` the background, `--glow` the pale highlight.

**Fonts** are Cinzel for display, Inter for body, JetBrains Mono for data and addresses. One Google Fonts link in the head.

**Artwork.** Replacing `banner.png` needs no code change. If it fails to load, the hero falls back to the Cinzel wordmark automatically, which is also what shows on screens under 760px where a 3:1 banner is unreadable.

**Icons.** `favicon.svg` is the source. Regenerate the raster sizes from it with any SVG to PNG tool at 180, 192, and 512, plus a 16/32/48 `.ico`.

**The proof section** is plain markup. Add an `<article class="proof">` block with a date, a struck through `.limit` line, a paragraph, and an `.after` line.

---

## Known limits

- X embeds are blocked by most ad blockers. The preview falls back to "Preview blocked" with an Open on X link, which is expected and not a bug.
- The ceiling uses last write wins. Two simultaneous presses can land on the same number for a moment. It self corrects on the next poll.
- Vercel Hobby has a monthly function invocation ceiling. The site polls DexScreener client side, so only the ceiling, ATH, and wall touch your functions.

---

## Legal

This is a memecoin site. The disclaimer in the footer of `index.html` covers no intrinsic value, no affiliation with Robinhood Markets or Pons Labs, total loss risk, and the discretionary nature of the community rewards.

If you change how rewards work, update that disclaimer to match. The wording that distributions are voluntary and that nobody is entitled to one is doing real work, and "post to earn tokens" is exactly the shape that draws scrutiny. Do not remove it to make the pitch sound stronger.

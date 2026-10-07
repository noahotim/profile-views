# profile-views

A live GitHub profile view counter with **private country analytics**, running on
Cloudflare Workers + KV.

- Public: a live `profile views` badge you embed in your profile README.
- Private: a dark dashboard showing total views, unique visitors, live viewers,
  and the country breakdown, protected by a secret key only you hold.

## What it does

| Route | Purpose |
| --- | --- |
| `GET /badge` | SVG badge showing the live total. Every load records a view. |
| `GET /api/track` | Record a view without rendering (for other apps). |
| `GET /api/stats?key=…` | JSON stats. Requires the secret key. |
| `GET /dashboard?key=…` | Private dashboard (auto-refreshes every 15s). |

Country is detected from `request.cf.country`, which Cloudflare populates from the
visitor's IP. No third party and no cookies.

## Setup

1. Install and log in:

   ```sh
   npm install
   npx wrangler login
   ```

2. Create the KV namespace and copy the printed `id` into `wrangler.toml`:

   ```sh
   npx wrangler kv namespace create PROFILE_VIEWS
   ```

3. Set the secret key that keeps countries private (use a long random string):

   ```sh
   npx wrangler secret put DASHBOARD_KEY
   ```

4. Deploy:

   ```sh
   npx wrangler deploy
   ```

5. Note the deployed URL, e.g. `https://profile-views.<your-subdomain>.workers.dev`.

## Add the badge to your profile README

In a repo named exactly `noahotim/noahotim`, add this line to `README.md`:

```md
![profile views](https://profile-views.<your-subdomain>.workers.dev/badge)
```

## View your country stats (only you)

Open the dashboard with your secret key:

```
https://profile-views.<your-subdomain>.workers.dev/dashboard?key=YOUR_SECRET
```

Bookmark it. Anyone without the key gets a 401 lock page, and the page is marked
`noindex,nofollow`.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then edit DASHBOARD_KEY
npm run dev
```

## Notes / limits

- KV writes are eventually consistent, so counts under heavy simultaneous traffic
  can lag slightly. For a profile page this is fine. Swap in a Durable Object if you
  ever need exact atomic counters.
- GitHub proxies images through its camo CDN, which can cache the badge for a while.
  The Worker sends `no-store`, so the badge still updates, just not instantly for
  every single visitor.

# Security notes (current)

## 1. Lock the admin panel with ADMIN_KEY (do this)

The admin panel has no login form. Out of the box it is **open**: anyone who calls `/api/site-data`,
`/api/media`, `/api/tool-zip` can publish, upload, delete and restore backups, and can add raw HTML to every page
(custom head code).

To lock it, in Cloudflare go to Workers & Pages > your project > Settings > Variables and Secrets and add a
**Secret** named `ADMIN_KEY`. Use a long random value of 32+ letters and numbers (plain ASCII, no spaces), then redeploy.

What happens once it is set:
- Every admin request must send the key (header `X-Admin-Token`); everything else gets 401.
- `/admin` asks for the key once per browser (saved in that browser) and then works as before.
- Visitors only receive the **published** copy of the site: pages, articles, projects, videos, photos and FAQs
  that are not published stay private. (Without `ADMIN_KEY` drafts are readable by anyone.)
- Opening a tool's admin files needs the owner login (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) or the key.

If you lose the key: change the secret in Cloudflare and enter the new one when `/admin` asks.
To clear the saved key in a browser, clear that site's local storage (`maskan_akey`).

## 2. Tool boxes: owner login

The HTML tool boxes' own admin tabs need the owner's username and password: add secrets **ADMIN_USERNAME** and
**ADMIN_PASSWORD**. Saving tool rates (`/api/tool-data` POST) needs the signed `X-Owner-Token` issued by that login
(valid 12 hours, 8 wrong tries per 15 minutes per IP). Tool data is public to read: never store private data in tool boxes.

## 3. Other settings
- Never leave `DEBUG_ERRORS=1` set: it shows real error messages and stack traces. Without it the browser only
  gets a generic message and the details stay in the Worker log.
- `CANONICAL_HOST` (optional): your main domain, for example `www.example.com`; other hosts are redirected there.
- Apply database migrations: `npx wrangler d1 migrations apply <your-db-name> --remote` (0001 and 0002).

## 4. What the code already does
Streaming request-size limits; picture uploads checked by file header; video chunks tied to the declared size;
safe tool ZIP handling (sandboxed, immutable once finished); parameterised SQL; HTML-escaped values and an allow-list
for rich text; HSTS, nosniff, Permissions-Policy, `frame-ancestors 'self'`; real 404 status for unknown addresses;
atomic publishing with an overwrite warning; automatic backups.

## 5. Known limits (your decision)
1. Without `ADMIN_KEY`, the site is editable by anyone (see section 1).
2. "Custom head code" and the AdSense ID accept raw HTML/IDs: anyone holding the admin key can run script on every page.
3. A full script Content-Security-Policy is not enabled because the site uses inline scripts, AdSense and embeds.
4. The backup file holds site content, tool data and file lists only. Photos, videos and tool ZIPs stay in R2:
   use R2 versioning or copy the bucket. Backups live in the same database as the site: download one regularly.
5. The whole published site (up to about 1.9 MB) is embedded in each page. Cloudflare compresses it, but keep photos
   in the Photo library instead of inside the page data.
6. Cloudflare Free plan: about 10 ms CPU per request and 50 database queries per request. Backup import and cleanups are
   written to stay within that, but the Workers Paid plan avoids CPU errors (1102).
7. Dependencies are pinned (including a beta `nitro`); run `npm audit` / `bun audit` before big updates.
8. The doc editor loads pdf.js, jszip and mammoth from public CDNs at a fixed version.

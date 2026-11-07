# HQ research activation

This file is the checklist. Nothing in the pull request applies it.

## What is already true

- Desktop live check at 1920×1072, relayed by Conductor: the COMMAND/READY core is visible in the center, agent sheets open, and the bottom modules are not clipped. This change does not treat desktop as a missing-core bug.
- Phone layout in local fixture tests: under 1000px, Agents and Chat are removed, and a short landscape viewport draws the bottom modules past the screen while `body` cannot scroll. Shortcuts in that layout open the same modules.
- `origin/main` is a single `index.html`. Supabase project ref in that file is `zjsvrfudkigjvvhlehdh`.
- Existing `listings`, `escrows`, `tasks`, and `notes` grants are untouched. They were reported to include `TRUNCATE`. Do not “clean those up” in this migration.

## Recommended host

Use a Netlify Function on the existing HQ site. Netlify’s documented JavaScript functions take a web `Request` and return a `Response`, and `path` may be a list. The site already has HTTPS. No new host.

Do not use a Supabase Edge Function for this publisher. Those functions run on Deno. The documented database client is `supabase-js`, and its admin client bypasses row security with the service-role key. This publisher must use the `hq_publisher` database role only.

The function is `netlify/functions/publisher.mjs`. It stays unconfigured, and answers 503, until the environment variables below exist. It does not use the service-role key.

## One setup the owner must do

In the Netlify UI for this site, set these runtime environment variables. Do not put the values in git, docs, or logs.

- `HQ_PUBLISHER_DATABASE_URL` — Postgres URL for role `hq_publisher` after that role has a password set on the Supabase database. Not the service-role key.
- `HQ_RESOURCE_URL` — `https://hq.hovikp.com`
- `HQ_OAUTH_CLIENT_ID` — a public client id you choose
- `HQ_OAUTH_REDIRECT_URIS` — the exact redirect URI shown when the Grok connector is added
- `HQ_OWNER_BOOTSTRAP_CODE` — a long random string. The connector sends it in a POST body, never in a URL.

Also apply `supabase/migrations/20261107143000_oauth_token_store.sql` after the research migration. It stores token hashes in `hq_private` and is not applied by this pull request.

Codes and refresh tokens are one-use. Reuse revokes the family in the database, so a second instance and a restart see the revocation. Publish still uses the transaction lock from the research migration.

This does not connect the stock bot. A live update still needs the function deployed with those variables, the connector OAuth flow completed, and one publish/readback test. None of that has been done.

## What is not activated

- No migration has been applied.
- No owner UUID is known here. Do not invent one. Do not read `auth.users` to guess.
- SPCX is not on the allowlist. Do not publish it until the issuer is verified.
- No holdings are preseeded. The screenshot symbols are not live data.
- The stock bot is not connected. Documentation says a Grok Bot can add a remote MCP server by URL, and that OAuth tokens for connected apps stay on the connector backend. The fetched docs do not show this publisher installed, authorized, or called by a routine.
- A routine webhook is an inbound trigger to Grok Bot, not an outbound writer.
- The Supabase developer SQL connector is not the scheduled writer. Do not point a routine at it.
- Hosted URL, OAuth client id, redirect URI, bootstrap code, and `hq_publisher` password are unset. The process exits if those environment variables are missing. It does not open an unauthenticated publisher.
- Paper analysis has no balance, fills, benchmark, or prices.

## Gate A — database, after explicit approval

1. Apply `supabase/migrations/20261107120000_research_publisher.sql` to project `zjsvrfudkigjvvhlehdh` only.
2. Insert exactly one `hq_private.owner_config` row: `singleton = 1`, `project_ref = 'zjsvrfudkigjvvhlehdh'`, `owner_id` = the confirmed HQ user’s `auth.uid()`. The person who knows that login must supply it through a secrets-safe channel.
3. Insert `hq_private.instrument_allowlist` rows only for instruments whose issuer and type are confirmed. `publishable` must stay false until `verification_state = 'verified'`. Leave SPCX out until then.
4. Keep `hq_publisher` as `NOLOGIN` until the password is set in the database host, not in git:
   `alter role hq_publisher login password '<from secret store>';`
   Grant `CONNECT` on the database and `USAGE` on schema `hq_private` is already in the migration. Do not grant table DML to this role. It may only execute `publish_stock_research` and `research_status`.
5. Confirm with a role test: `authenticated` can `SELECT` only when `auth.uid()` is that owner; `anon` cannot; `authenticated` cannot `INSERT`; a second user sees zero rows.

The service-role key bypasses RLS on the existing business tables. This path does not use it. Do not put that key in the publisher.

## Gate B — host the MCP process

Environment names only. Values stay in the host secret store.

- `HQ_RESOURCE_URL` — public `https` origin. Unknown until a host is chosen.
- `HQ_OAUTH_CLIENT_ID` — provisioned client id for the Grok connector.
- `HQ_OAUTH_REDIRECT_URIS` — comma-separated exact redirect URIs from that connector.
- `HQ_OWNER_BOOTSTRAP_CODE` — long random string the owner types into the authorize step. Rotate by changing the secret and revoking tokens.
- `HQ_PUBLISHER_DATABASE_URL` — connection string for role `hq_publisher` only.
- `PORT` — optional, default 8787, bound to localhost behind the TLS proxy.

`node publisher/server.mjs` refuses to listen if any required name is missing.

OAuth in this process: authorization code plus PKCE S256, public client, 60-second codes, 10-minute access tokens, rotating refresh tokens. Reuse of an old refresh token revokes the family. Scopes are only `research.publish` and `research.status.read`. There is no anonymous `/mcp`.

This matches the documented class “custom remote MCP by URL” plus connector-held OAuth. It is not proof Grok Bot’s add-by-URL flow will complete this handshake. That is a live connect test, Gate C.

## Gate C — one controlled test, then a routine

1. Add the MCP server by URL in Grok Bot. Approve it if the host is private.
2. Finish Authorize. Tokens should remain on the connector backend, not in chat.
3. Call `research_status` once. Expect `owner_not_configured` before Gate A, or a receipt after it.
4. Call `publish_stock_research` with one fixture finding for an allowlisted symbol and `outcome: "publish"`. Read it back in HQ as that owner. A second user and a signed-out browser must not see it.
5. Repeat the same `run_id` and body. The receipt is `replay: true` and the row count does not grow.
6. Send a different body with the same `run_id`. Expect `replay_conflict` and unchanged notes.
7. Send an older `researched_at`. Expect `stale_run` and the previous notes still visible.
8. Send `outcome: "no_change"`. Notes stay.
9. Only after that, ask the owning Bot to schedule a routine that calls this connector. Do not schedule it against the Supabase SQL connector. A failed run must report failure and must not clear the last good notes.

## Rollback

Revoke the connector and `alter role hq_publisher nologin`. Leave the tables. HQ shows the last published notes with their timestamps. Boot, login, and the existing panels do not depend on the publisher process.

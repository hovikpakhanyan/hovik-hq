# HQ research activation

This file is the only provisioning checklist. Nothing in the pull request applies it, merges it, or deploys a live publisher. Merging this pull request publishes the Netlify Function, so it stays unmerged until review.

The page microphone is a local visualizer. It is not this connection. No xAI API client is added. A typed Bot webhook is not part of this publisher.

## The one host

Use the Netlify Function already in this repository, `netlify/functions/publisher.mjs`, on the existing site `https://hq.hovikp.com`. Netlify’s JavaScript functions take a web `Request` and return a `Response`. The site already has HTTPS. No new host and no new account.

Do not run `publisher/server.mjs`. That process is not a supported route. Do not use a Supabase Edge Function: its documented admin client uses the service-role key, which bypasses row security.

The function answers 503 until the environment names below are set. It does not use the service-role key.

## Database connection

Use the existing Supabase shared transaction pooler. Copy the host from the project’s Connect dialog, Transaction pooler. The host cannot be derived from the region. The documented shape is:

`postgresql://hq_publisher.zjsvrfudkigjvvhlehdh:[PASSWORD]@[POOLER-HOST]:6543/postgres?sslmode=require`

- User is `hq_publisher.zjsvrfudkigjvvhlehdh`, the custom role through the shared pooler. Not `postgres`, not `postgres.[ref]`, and not `service_role`.
- Port `6543` is transaction mode. The function keeps one connection per warm instance and does not name prepared statements.
- `sslmode=require` is mandatory. `disable`, `allow`, and `prefer` are refused. `verify-full` is accepted when the URL also carries the dashboard root certificate.
- The password is set on the database role, then placed only in the Netlify secret. It is not written here.

## Secret names

Set these in the Netlify UI. Values stay there.

- `HQ_PUBLISHER_DATABASE_URL` — the pooler URL above.
- `HQ_RESOURCE_URL` — `https://hq.hovikp.com`
- `HQ_OAUTH_CLIENT_ID` — a public client id you choose for the connector.
- `HQ_OAUTH_REDIRECT_URIS` — the exact redirect URI the connector shows, comma-separated if it shows more than one.
- `HQ_OWNER_BOOTSTRAP_CODE` — a long random string. The owner types it into the consent form. It is not a URL parameter.

Scopes are only `research.publish` and `research.status.read`.

## What the owner must do

These steps are not done by the pull request.

1. Apply `supabase/migrations/20261107120000_research_publisher.sql` to project `zjsvrfudkigjvvhlehdh`.
2. Apply `supabase/migrations/20261107143000_oauth_token_store.sql`.
3. Apply `supabase/migrations/20261107170000_oauth_guard.sql`.
4. Insert one `hq_private.owner_config` row: `singleton = 1`, `project_ref = 'zjsvrfudkigjvvhlehdh'`, `owner_id` = the HQ user’s `auth.uid()`. The person who knows that login supplies it. Do not read `auth.users` to guess.
5. Insert `hq_private.instrument_allowlist` rows only for instruments whose issuer is confirmed. Leave `publishable` false until `verification_state = 'verified'`. Leave SPCX out.
6. Set the role password in the database host: `alter role hq_publisher login password '<from the secret store>';`
7. Set the five Netlify names above.
8. Add the MCP server by its HTTPS URL in Grok Bot. The browser opens `GET /oauth/authorize`. The page shows the exact redirect and the scopes, then posts the owner code. The code is not put in the URL or in a log.
9. Call `research_status` once, then one `publish_stock_research` for an allowlisted symbol, and read it back while signed in as that owner. Repeat the same `run_id` and expect `replay: true`.

`hq_publisher` can execute the publisher and token functions. It cannot select or change the token tables. `anon` and `authenticated` cannot execute them. Expired codes and access tokens are deleted. A used refresh token stays until it expires so a replay can still revoke its family.

Authorize and token attempts are counted in Postgres, 20 and 60 per ten minutes for one client, so a second function instance sees the same limit. A wrong owner code after the limit returns `rate_limited` and is not checked again.

## What a 401 means

`POST /mcp` without a usable token returns 401. The `WWW-Authenticate` header includes `resource_metadata` for `https://hq.hovikp.com/.well-known/oauth-protected-resource` and the two scopes. That document’s `resource` is `https://hq.hovikp.com/mcp`. Its authorization server is `https://hq.hovikp.com`.

## What is not activated

- No migration has been applied.
- The stock bot is not connected. A connector OAuth completion and one publish/readback are still required.
- A routine webhook is an inbound trigger to Grok Bot, not this publisher.
- The Supabase SQL connector is not the writer.
- Paper analysis has no balance, fills, or prices.

## Rollback

Revoke the connector and run `alter role hq_publisher nologin`. Leave the tables. HQ keeps the last published notes. Boot, login, and the panels do not depend on this function.

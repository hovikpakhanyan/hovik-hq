# HQ publisher keys

Long-lived keys are a second way to call the research publisher at `https://hq.hovikp.com/mcp`, next to the existing OAuth flow, which is unchanged. Nothing in this pull request applies the migration, inserts a key, or changes Netlify settings.

## What a key is

- Format: `hqpk_` followed by 32 random bytes in base64url (48 characters in total).
- Sent as `Authorization: Bearer hqpk_…` on `POST /mcp`.
- HQ stores only the SHA-256 hex of the whole key string (prefix included) in `hq_private.publisher_keys.key_hash`. The plaintext is never written to the database, a log, or the repository.
- Each key belongs to one client, carries that client's fixed scopes, expires 90 days after it is created, and can be revoked on its own.
- An unknown, revoked, or expired key gets the same `401` and `WWW-Authenticate` challenge as a bad OAuth token. Failed key attempts are counted in Postgres (`mcp_key_fail`, 60 per ten minutes across all instances); past that, key failures return `429`.

## Clients and scopes

| Client | Scopes | Tools |
| --- | --- | --- |
| `grok-bot` | `research.publish`, `research.status.read` | `publish_stock_research`, `research_status` |
| `claude` | `research.publish`, `research.status.read`, `research.read` | `publish_stock_research`, `research_status`, `read_stock_research` |
| `instinct` | `research.status.read`, `research.read` | `research_status`, `read_stock_research` |

`read_stock_research` is new and read-only. It returns the bound owner's own published research notes, newest first (at most 50, optional `symbol` and `run_id` filters). It returns no watchlist, deal, listing, pipeline, or escrow data, and no owner id.

No key can call `publish_deal` or `deal_status`, whatever its scopes. A table check (`publisher_keys_client_scopes`) also limits each client's scopes in the database, so no row can ever hold a deal, listing, pipeline, or escrow scope. `grok-bot` and `claude` may hold `research.publish`; `instinct` may not. Scopes for new keys come from the database by client name, never from the caller. A key that already exists keeps the scopes stored on its row.

OAuth tokens keep their two scopes and their current tool list. They do not get `read_stock_research`.

## Apply

After review and the owner's approval, apply `supabase/migrations/20261122170000_publisher_keys.sql` to project `zjsvrfudkigjvvhlehdh`. It needs the research, OAuth token, and OAuth guard migrations, and does not need or touch `20261111223000_deal_publisher.sql`.

Then apply `supabase/migrations/20261123053000_claude_publish_scope.sql`. It replaces `publisher_keys_client_scopes` and recreates `publisher_key_issue` (and `publisher_key_default_scopes`, which the issuer calls) so a new `claude` key receives `research.publish`, `research.status.read`, and `research.read`. `publisher_keys_scopes_known` stays as it is. Existing rows are not updated. `grok-bot` stays `research.publish` and `research.status.read`. `instinct` stays `research.status.read` and `research.read`. This migration does not touch `20261111223000_deal_publisher.sql`.

`hq_publisher` gets no privileges on the key table. It can only execute `publisher_key_check`, `publisher_key_issue`, `publisher_key_list`, `publisher_key_revoke`, and `read_stock_research`. `anon` and `authenticated` cannot execute any of them.

## Issue a key on HQ (owner page)

Open `https://hq.hovikp.com/publisher/keys`.

1. Pick a client, add an optional label, type the owner code, and press **Create key**.
2. The next page shows the key once. Select it and copy it into the client's `Authorization: Bearer` header. HQ cannot show it again.
3. **Show existing keys** lists client, label, scopes, created, expires, revoked, and last used. It never shows hashes or keys. Each active key has a **Revoke** button that asks for the owner code again.

The page uses the same owner code and exact comparison as the OAuth consent form, counts attempts in Postgres (20 per ten minutes), only acts on `POST`, refuses a cross-site `Origin`, refuses an owner code in the URL, and sends `no-store`, `no-referrer`, and `frame-ancestors 'none'` headers. A client can have at most three active keys, so a rotation can overlap.

## Insert a key by SQL instead

Generate the key on a trusted machine and keep only the hash for SQL:

```sh
key="hqpk_$(openssl rand 32 | basenc --base64url | tr -d '=\n')"
printf %s "$key" | sha256sum | cut -d' ' -f1   # this hex is the key_hash
```

```sql
select hq_private.publisher_key_issue('<64-char sha256 hex>', 'grok-bot', 'main');
-- or directly, with the client's fixed scopes:
insert into hq_private.publisher_keys (client, label, key_hash, scopes)
values ('grok-bot', 'main', '<64-char sha256 hex>', array['research.publish', 'research.status.read']);
```

## Revoke

```sql
update hq_private.publisher_keys set revoked_at = now() where id = '<key id>' and revoked_at is null;
-- every key for one client:
update hq_private.publisher_keys set revoked_at = now() where client = 'claude' and revoked_at is null;
```

Revocation takes effect on the next request.

## Rotate

Issue a new key for the same client, put it in the client, confirm a call works (the old key's `last_used_at` stops moving), then revoke the old key. Rotate before `expires_at`; an expired key returns `401`.

## Client setup

- **Grok Bot (stock publisher):** MCP URL `https://hq.hovikp.com/mcp`, header `Authorization: Bearer <grok-bot key>`.
- **Claude Desktop or Claude Code:** add an HTTP MCP server with URL `https://hq.hovikp.com/mcp` and header `Authorization: Bearer <claude key>`. For example, `claude mcp add --transport http hq https://hq.hovikp.com/mcp --header "Authorization: Bearer <claude key>"`.
- **Claude on claude.ai (custom connector):** its custom connector form uses OAuth, not a static header. See the OAuth note below.
- **Instinct or another generic MCP client:** Streamable HTTP transport, URL `https://hq.hovikp.com/mcp`, a static `Authorization: Bearer <instinct key>` header. Requests are JSON-RPC `POST`s; `initialize`, `tools/list`, and `tools/call` are supported.

## Claude OAuth note (optional, after merge)

The OAuth server has one static public client and no dynamic client registration, so a client must be given the client id by hand. To let claude.ai connect through OAuth:

1. Add `https://claude.ai/api/mcp/auth_callback` to the Netlify setting `HQ_OAUTH_REDIRECT_URIS` (comma-separated with the existing value) and redeploy. This is a settings change, not code.
2. In Claude's custom connector **Advanced settings**, enter the OAuth client id (the value of `HQ_OAUTH_CLIENT_ID`, currently `hq-grok-bot`) and leave the client secret empty.
3. The consent page asks for the owner code.

An OAuth grant gets `research.publish` and `research.status.read` and the full OAuth tool list, including `publish_deal` and `deal_status`. A new `claude` key can publish and read research, and still cannot call those deal tools. Prefer the key where Claude supports a header.

## Rollback

- Revoke every key: `update hq_private.publisher_keys set revoked_at = now() where revoked_at is null;`
- Revert the code: OAuth keeps working because its path is unchanged.
- Remove the database objects if wanted:

```sql
drop function if exists hq_private.read_stock_research(int, text, uuid);
drop function if exists hq_private.publisher_key_revoke(uuid);
drop function if exists hq_private.publisher_key_list();
drop function if exists hq_private.publisher_key_issue(text, text, text);
drop function if exists hq_private.publisher_key_check(text);
drop function if exists hq_private.publisher_key_default_scopes(text);
drop table if exists hq_private.publisher_keys;
```

## Tests

- `node --test test/*.test.mjs` covers key format, hash-only storage, per-client scopes, deal-tool denial, revoked and expired keys, rate limits, OAuth unchanged, and the owner page headers.
- `HQ_TEST_DATABASE_URL=… HQ_TEST_PUBLISHER_URL=… node test/publisher-keys-persist.mjs` runs against a scratch database with the research, OAuth token, OAuth guard, publisher key, and claude publish-scope migrations applied (not `20261111223000_deal_publisher.sql`) and checks the table constraints, grants, `last_used_at`, revocation, expiry, and owner-only reads.

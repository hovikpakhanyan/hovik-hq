# HQ publisher keys

Long-lived keys are a second way to call HQ at `https://hq.hovikp.com/mcp`, next to the existing OAuth flow. OAuth scopes stay `research.publish` and `research.status.read`. Nothing in this pull request applies a migration, inserts a key, or changes Netlify settings.

Do not merge or apply migrations until Hovik approves.

## What a key is

- Format: `hqpk_` followed by 32 random bytes in base64url (48 characters in total).
- Sent as `Authorization: Bearer hqpk_…` on `POST /mcp`.
- HQ stores only the SHA-256 hex of the whole key string (prefix included) in `hq_private.publisher_keys.key_hash`. The plaintext is never written to the database, a log, or the repository. The check compares that hash in constant time.
- Each key belongs to one client, carries that client's fixed scopes, expires 90 days after it is created, and can be revoked on its own.
- An unknown, revoked, or expired key gets the same `401` and `WWW-Authenticate` challenge as a bad OAuth token. Failed key attempts are counted in Postgres (`mcp_key_fail`, 60 per ten minutes across all instances); past that, key failures return `429`.
- There is no service-role key, no raw SQL tool, and no trade or order tool.

## Where HQ data lives

| Domain | Home today | Who can use it |
| --- | --- | --- |
| Research | `public.ingestion_runs`, `public.research_findings`. RLS: the bound owner can select. Writes go through `hq_private.publish_stock_research`. | OAuth with `research.publish` / `research.status.read`. Keys with the matching `research.*` scope. |
| Watchlist | `public.watchlist` (owner, bucket, symbol, asset type, sort). RLS select already. This change adds owner insert, update, and delete policies. No sizes or quotes. | Keys with `watchlist.read` / `watchlist.write`. The signed-in owner can also write through Supabase auth. `publish_stock_research` can still replace the whole list. |
| Listings, pipeline, escrow | `public.deal_records` in `20261111223000_deal_publisher.sql`, which has not been applied in production. `kind` is `listing`, `pipeline`, or `escrow`. This change adds `archived_at`. There is no hard delete. | OAuth `publish_deal` / `deal_status` stay on the research scopes. Keys need `listings.*`, `pipeline.*`, or `escrow.*` for the matching kind. |
| Legacy listings and escrows | `public.listings` and `public.escrows`. The page reads `data` jsonb. These tables are not created in this repo. The research migration says they already exist in production and must not be altered. | The site only. No new MCP tool writes them. |
| Legacy tasks | `public.tasks`. The page reads and writes `{ id, data }`. Not created in this repo, and not altered here. | The site only, plus whatever grants that table already has. |
| Tasks for keys | New `public.hq_tasks` (owner, subject, note, priority, completed). RLS lets the bound owner select, insert, update, and delete. | Keys with `tasks.read` / `tasks.write`. |
| Notes | No notes table is queried by the page. Conductor notes are browser-only (below). New `public.hq_notes` is the key-facing store. If a legacy `public.notes` table exists, this change does not touch it. | Keys with `notes.read` / `notes.write`. The owner can write `hq_notes` from the site. |
| Investment plan | Static file `investment-plan.md`. The Markets page fetches that file. New `public.hq_plan` holds one markdown row per owner. The migration does not copy the file in. | Keys with `plan.read` / `plan.write`. The export button copies the file. |
| Chat replies | Not stored. The chat panel is a local shortcut in the page. | Nobody remote. |

`hq_publisher` has no table privileges. It can only execute security-definer functions. Those functions take the owner from `hq_private.owner_config`. A key write also checks that the key row is active and holds the scope for that tool.

### localStorage-only data

These stay in the browser. The export button does not read the markets keys.

| Key | What it is |
| --- | --- |
| `hq.tasks.v1.<user id>` | Task patches and tasks created on this device. The export copies them into `hq_tasks`. The page still keeps the legacy `tasks` path. |
| `hq.conductor.outbox.v1` | Conductor notes, latest 100. The export copies them into `hq_notes` with source `conductor`. |
| `hq.markets.figures.v1.<user id>` | Manual and projected figures typed on the Markets page. Not exported. |
| `hq.markets.paper.v1.<user id>` | Play-money balance and rehearsals. Not exported. Not an order. |
| `hq.windows.v1.<user id>` | Window positions. Layout only. |
| `sb-*` | Supabase auth session. Cleared when the page loads. |

The hardcoded `TRACKED` list in the Markets section is page copy, not the watchlist table, and it is not exported.

### Seeding

Migrations insert no listings, tasks, notes, watchlist rows, plan text, prices, or owner ids.

The signed-in owner can press **Export local data to HQ** on the tasks panel. That reads this browser's task store and conductor outbox, fetches `investment-plan.md`, and upserts them with the Supabase session. It does not read manual figures or paper trades. If the new tables are not there yet, the page says so and leaves the browser data alone.

The Markets page still renders the plan from the file. Pointing that page at `hq_plan` is a follow-up, left out so this change does not edit the Markets section.

## Clients and scopes

New `grok-bot` and `claude` keys get every scope below. `instinct` does not. A key that already exists keeps the scopes stored on its row. The migration does not update rows.

| Client | Scopes | Tools |
| --- | --- | --- |
| `grok-bot` | `research.publish`, `research.status.read`, `research.read`, `listings.read`, `listings.write`, `pipeline.read`, `pipeline.write`, `escrow.read`, `escrow.write`, `tasks.read`, `tasks.write`, `notes.read`, `notes.write`, `watchlist.read`, `watchlist.write`, `plan.read`, `plan.write` | Research publish, status, and read. `publish_deal` and `deal_status` when the kind matches. List, get, create, and update for listings, pipeline, escrow, and the plan. List, get, create, update, and delete for tasks, notes, and watchlist membership. |
| `claude` | Same full set as `grok-bot` | Same tools as `grok-bot` |
| `instinct` | `research.status.read`, `research.read` | `research_status`, `read_stock_research` |

Deal kind maps to scope: `listing` uses `listings.*`, `pipeline` uses `pipeline.*`, `escrow` uses `escrow.*`. `publish_deal` needs the write scope for that kind. `deal_status` needs the read scope. Counts omit archived rows. Update with `archive: true` sets `archived_at`. It does not delete the row.

Writes are limited to 60 accepted calls per tool per hour (`hq_private.mcp_write_attempts`). `publish_deal` keeps its own 30 per hour. Every successful write inserts `hq_private.mcp_audit` (client, key id, tool, time, row id). OAuth deal publishes are audited as client `oauth` with a null key id.

OAuth tokens do not get `research.read` or the new domain tools. They can still call `publish_deal` and `deal_status` with the two research scopes.

## Apply

Apply to project `zjsvrfudkigjvvhlehdh` only after review, in this order. Each file should run in one transaction (`psql -1`), because two of them take a lock.

1. `supabase/migrations/20261107120000_research_publisher.sql`
2. `supabase/migrations/20261107143000_oauth_token_store.sql`
3. `supabase/migrations/20261107170000_oauth_guard.sql`
4. `supabase/migrations/20261111223000_deal_publisher.sql` (required now; it was previously out of this path)
5. `supabase/migrations/20261122170000_publisher_keys.sql`
6. `supabase/migrations/20261123053000_claude_publish_scope.sql`
7. `supabase/migrations/20261123180000_hq_domain_access.sql`

If 5 and 6 are already applied, apply 4 and then 7. Do not edit the earlier files. 7 aborts if `deal_records` or the publisher-key functions are missing, and it aborts if it would change an existing key row.

Deploy the function only after 7 is applied. `publish_deal` from the app calls `hq_private.publish_deal_audited`.

## Existing keys

The migration does not change key rows. The live `grok-bot` key `af8652dd-73a4-4520-be55-0c3b195bf1de` keeps `research.publish` and `research.status.read` until it is replaced.

Prefer a new key. Generate it on a trusted machine, issue it, confirm a call, then revoke the old one. Issuing uses the new default scopes and a fresh 90-day expiry. This statement is not part of the migration:

```sql
select hq_private.publisher_key_issue('<64-char sha256 hex>', 'grok-bot', 'full-access');
-- after the new key works:
update hq_private.publisher_keys
set revoked_at = now()
where id = 'af8652dd-73a4-4520-be55-0c3b195bf1de' and revoked_at is null;
```

Widening that same row keeps the same secret and does not extend `expires_at`. Use it only if a reissue is not possible:

```sql
update hq_private.publisher_keys
set scopes = hq_private.publisher_key_default_scopes('grok-bot')
where id = 'af8652dd-73a4-4520-be55-0c3b195bf1de'
  and client = 'grok-bot'
  and revoked_at is null;
```

`instinct` cannot hold the new scopes. The table check rejects that insert.

## Issue, revoke, rotate

Open `https://hq.hovikp.com/publisher/keys`.

1. Pick a client, add an optional label, type the owner code, and press **Create key**.
2. The next page shows the key once. Copy it into the client's `Authorization: Bearer` header. HQ cannot show it again.
3. **Show existing keys** lists client, label, scopes, created, expires, revoked, and last used. It never shows hashes or keys. Each active key has a **Revoke** button.

The page uses the same owner code and exact comparison as the OAuth consent form, counts attempts in Postgres (20 per ten minutes), only acts on `POST`, refuses a cross-site `Origin`, refuses an owner code in the URL, and sends `no-store`, `no-referrer`, and `frame-ancestors 'none'` headers. A client can have at most three active keys.

Revoke one key, or every key for a client:

```sql
update hq_private.publisher_keys set revoked_at = now() where id = '<key id>' and revoked_at is null;
update hq_private.publisher_keys set revoked_at = now() where client = 'claude' and revoked_at is null;
```

Revocation takes effect on the next request. Rotate by issuing a new key, confirming a call, then revoking the old one. An expired key returns `401`.

## Client setup

- **Grok Bot:** MCP URL `https://hq.hovikp.com/mcp`, header `Authorization: Bearer <grok-bot key>`.
- **Claude Desktop or Claude Code:** `claude mcp add --transport http hq https://hq.hovikp.com/mcp --header "Authorization: Bearer <claude key>"`.
- **Claude on claude.ai** still uses OAuth, not a static header. An OAuth grant gets the two research scopes and can call `publish_deal` / `deal_status`. It does not get the new domain tools. Prefer a key where Claude supports a header.
- **Instinct:** URL `https://hq.hovikp.com/mcp`, header `Authorization: Bearer <instinct key>`. Research status and research read only.

## Risks

A leaked `claude` or `grok-bot` key can read HQ and can change it: edit listing, pipeline, and escrow records (including archive), edit the watchlist and the stored plan, and create, edit, or delete tasks and notes. It cannot hard-delete a listing or escrow row, run SQL, use a service-role key, or place a trade.

Mitigations: one key can be revoked without touching the others, keys expire after 90 days, writes are rate limited, and every write is in `hq_private.mcp_audit`. `instinct` cannot hold those scopes. The owner session can also write `hq_tasks`, `hq_notes`, `hq_plan`, and `watchlist` because that is how the export works. RLS still requires `auth.uid()` to be the bound owner.

Compromised manual figures and paper rehearsals stay in the browser. They are not in the key surface.

## Rollback

- Revoke every key: `update hq_private.publisher_keys set revoked_at = now() where revoked_at is null;`
- Revert the function code. OAuth research calls keep working. Deal calls from the new code need `publish_deal_audited`, so revert the function if that migration is rolled back.
- Drop the new objects only if the owner wants them gone. Do not drop `deal_records` here if it holds rows the owner means to keep.

```sql
drop function if exists hq_private.publish_deal_audited(jsonb, text, uuid);
drop function if exists hq_private.plan_mutate(text, jsonb, text, uuid);
drop function if exists hq_private.plan_read(uuid);
drop function if exists hq_private.watch_mutate(text, jsonb, text, uuid);
drop function if exists hq_private.watch_rows(uuid, text, text, integer);
drop function if exists hq_private.note_mutate(text, jsonb, text, uuid);
drop function if exists hq_private.note_rows(uuid, integer);
drop function if exists hq_private.task_mutate(text, jsonb, text, uuid);
drop function if exists hq_private.task_rows(uuid, integer, boolean);
drop function if exists hq_private.deal_mutate(text, text, jsonb, text, uuid);
drop function if exists hq_private.deal_counts(text[]);
drop function if exists hq_private.deal_rows(text, text, integer, boolean);
drop function if exists hq_private.deal_write_scope(text);
drop function if exists hq_private.audit_write(text, uuid, text, text);
drop function if exists hq_private.mcp_gate(text, uuid, text, text);
drop function if exists hq_private.payload_gate(jsonb, text[], integer);
drop table if exists public.hq_plan;
drop table if exists public.hq_notes;
drop table if exists public.hq_tasks;
drop table if exists hq_private.mcp_write_attempts;
drop table if exists hq_private.mcp_audit;
```

Restoring the old scope checks is a separate reviewed migration. Do not do it by editing an applied file in place.

## Tests

- `node --test test/*.test.mjs` covers key format, hash-only storage, the full scope set, instinct denial, deal and task tools, archive instead of delete, OAuth's unchanged tool list, and the export button staying off the Markets page.
- `HQ_TEST_DATABASE_URL=… HQ_TEST_PUBLISHER_URL=… node test/publisher-keys-persist.mjs` runs against a scratch database with every migration applied, including the deal migration and `20261123180000_hq_domain_access.sql`. It checks constraints, grants, audit rows, archive, and that `instinct` cannot write.

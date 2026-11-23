# Deal publishing

This file is the contract for listing, pipeline, and escrow updates. Nothing in the pull request applies the migration, sets a secret, or writes a sample row.

The HQ page reads `deal_records` for the listings, pipeline, and escrow panels when that table has rows. `kind` is `listing`, `pipeline`, or `escrow`. A listing uses lane `current`, `upcoming`, or `sold`; pipeline uses `pipeline`; escrow uses `escrow`. Rows with `archived_at` set stay off the panels. If `deal_records` is missing or has no rows, the page still reads `listings` and `escrows` that are already on file. Amounts on the tracker are sums of stored net estimates, or zero with a label when none are stored.

## Where it runs

Use the existing Netlify function `netlify/functions/publisher.mjs` on `https://hq.hovikp.com`. It returns 503 until the research publisher secrets are set. No new secret name is added. The function does not use the service-role key.

`POST /mcp` is the only write path. A missing `hq_private.publish_deal` function fails closed as `unavailable`. Do not point Conductor at the Supabase SQL editor.

## Auth

OAuth scopes stay `research.publish` and `research.status.read`.

- `publish_deal` requires a bearer token whose scope includes `research.publish`.
- `deal_status` requires `research.status.read`.

Publisher keys are different. A `grok-bot` or `claude` key needs `listings.write`, `pipeline.write`, or `escrow.write` for the record's kind. `instinct` cannot call these tools. The scope table, audit log, and archive rule are in `docs/PUBLISHER_KEY.md`. OAuth does not gain those key scopes.

The consent page tells the owner that this same approval can publish deal records. It does not add a scope. A token minted before this change that already has `research.publish` can call `publish_deal` after the function is deployed and the migration is applied.

## publish_deal

MCP `tools/call`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "publish_deal",
    "arguments": {
      "schema_version": 1,
      "record_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "external_key": "thread-1842",
      "kind": "escrow",
      "lane": "escrow",
      "title": "Address from the monitored message",
      "status_label": "Unconfirmed",
      "note": "Short extract. Optional.",
      "updated_at": "2026-11-11T18:00:00Z"
    }
  }
}
```

Omit `price_cents` and `net_est_cents` when the message has no amount. Do not send `0` as a stand-in. `closed_on` is allowed only when `lane` is `sold`, as `YYYY-MM-DD`.

`kind` and `lane`:

- listing: `current`, `upcoming`, or `sold`
- pipeline: `pipeline`
- escrow: `escrow`

`external_key` is the stable id from the monitored message, 1–80 characters from `A-Z a-z 0-9 . _ : -`. Sending a new `record_id` with the same `external_key` updates that row. Sending the same `record_id` and the same payload returns `replay: true`. The same `record_id` with a different payload returns `replay_conflict`.

Rejected fields, anywhere in the payload: `owner_id`, `destination`, `sql`, `query`, credentials, secrets, `service_role`, `project_ref`, and quote names (`price`, `quote`, `last`, `bid`, `ask`, `balance`, `shares`, `quantity`, `pnl`, `market_value`, `nav`, `open`, `high`, `low`, `close`, `volume`). Record amounts use `price_cents` and `net_est_cents` only.

The owner id is read from `hq_private.owner_config`. The caller cannot choose it. Thirty accepted calls per hour per owner. Calls more than two minutes in the future or more than ten years old are rejected.

## deal_status

`deal_status` with no arguments returns counts only. With `external_key`, it returns that row's kind, lane, title, status, cent amounts, close date, and source time. It does not return the note.

## What HQ shows

Active listings, pipeline, and escrows are tabs in one window. Those tabs use `deal_records` when that table has rows, and the legacy `listings` and `escrows` tables when it does not. The full page sums pipeline net estimates into projected earnings and sums sold records whose `closed_on` falls in the current America/Los_Angeles year. A sold row with no close date is listed and is not added to the year total. A status string such as a year is not treated as money. Tasks on the page read `hq_tasks` when that table has rows, and `tasks` otherwise. The investment plan block reads `hq_plan` when that row has body text, and `investment-plan.md` otherwise. Conductor’s note list shows open `hq_notes` when that table has rows, and keeps device notes that are not already in it.

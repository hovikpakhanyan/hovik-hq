# Conductor handoff

Notes typed in the Agents office are queued on this device. They are not delivered, and the page does not invent a reply.

No new secret is required. The browser does not hold a service-role key. Nothing is posted to Netlify until a later connection replaces `window.HQConductorHandoff.send`.

## Queue

`localStorage` key `hq.conductor.outbox.v1` is a JSON array. Each item:

```json
{
  "id": "msg-abc",
  "botId": "1a4d30cc-d5e0-4ab7-955d-68239fbe4974",
  "botName": "Conductor",
  "text": "The note that was typed",
  "at": "2026-11-11T23:40:00.000Z",
  "status": "pending"
}
```

`botId` is the opened figure:

- Conductor: `1a4d30cc-d5e0-4ab7-955d-68239fbe4974`
- New Bot: `6f32561d-95e6-4677-9136-8afa66fdddff`
- HQ Deployer: `fe79067c-3356-4ef8-90dc-45c919731803`

`status` is `pending` until a future connector marks it otherwise. The array keeps the latest 100 notes.

## Hook

```js
const result = window.HQConductorHandoff.send({
  botId: "6f32561d-95e6-4677-9136-8afa66fdddff",
  text: "Look at the watchlist when the feed is connected."
});
```

Today the function:

- returns `{ ok: false, status: "empty" }` when the text is blank, and does not write a row
- returns `{ ok: false, status: "unknown_bot" }` for any other id
- otherwise appends one `pending` row and returns `{ ok: true, status: "pending", configured: false, queued: true, message }`

`configured: false` means the handoff is not connected. The office shows “Queued on this device. Will reach Conductor when that handoff is connected.”

`window.HQConductorHandoff.list()` returns the current array.

A later connection can replace `window.HQConductorHandoff.send` with a function that uses the same arguments and returns the same shape, with `configured: true` only after a real accept. Do not point that replacement at a service-role key or a new secret name from this page.

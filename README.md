# pagerduty-alert

Cloudflare Worker that receives Cloudflare Notification webhook alerts and other Workers' uncaught exceptions, forwarding both to the PagerDuty Events API v2 as `trigger` events.

## How it works

### Notification webhook alerts

1. Configure a **Webhook destination** in the Cloudflare dashboard (Notifications → Destinations → Webhooks) pointing at `https://<your-worker>.workers.dev/webhook`, with a secret. Cloudflare sends that secret back on every request as the `cf-webhook-auth` header.
2. Attach the webhook destination to whichever alert notifications you want forwarded (Notifications → All Notifications).
3. This Worker verifies the `cf-webhook-auth` header, then POSTs a PagerDuty Events API v2 `trigger` event built from the alert payload to `https://events.pagerduty.com/v2/enqueue`.

### Exceptions from other Workers

This Worker can also act as a [Tail Worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) for other Workers: it exports a `tail()` handler that receives their execution trace events, and for every trace item that logged an exception it POSTs a `trigger` event to PagerDuty (severity `error`, one event per exception).

To wire up a producer Worker, add a `tail_consumers` entry to its Wrangler config pointing at this Worker's name:

```jsonc
// producer worker's wrangler.jsonc
{
	"tail_consumers": [{ "service": "pagerduty-alert" }],
}
```

No extra auth is needed for this path — tail events are delivered internally by the Workers runtime, not over public HTTP.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values for local dev
```

Required secrets (set for local dev in `.dev.vars`, and in production via `wrangler secret put`):

| Name | Description |
| --- | --- |
| `PAGERDUTY_ROUTING_KEY` | The integration/routing key from a PagerDuty service's "Events API v2" integration |
| `CF_WEBHOOK_SECRET` | Shared secret configured on the Cloudflare webhook destination; verified on every incoming request |

## Local development

```bash
npm run dev
```

## Deploy (manual)

```bash
npx wrangler secret put PAGERDUTY_ROUTING_KEY
npx wrangler secret put CF_WEBHOOK_SECRET
npm run deploy
```

## Test & lint

```bash
npm test
npm run typecheck
npm run lint
```

## CI/CD

`.github/workflows/deploy.yml` runs lint, typecheck, and tests on every push and pull request against `main`. On a push to `main`, it also deploys the Worker with `cloudflare/wrangler-action`, which uploads the code and syncs the `PAGERDUTY_ROUTING_KEY` / `CF_WEBHOOK_SECRET` Worker secrets from GitHub Actions secrets (no values are stored in the repo).

Configure these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with `Workers Scripts:Edit` permission for the target account |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `PAGERDUTY_ROUTING_KEY` | Same value as the local Worker secret above |
| `CF_WEBHOOK_SECRET` | Same value as the local Worker secret above |

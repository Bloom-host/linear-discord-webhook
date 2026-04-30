![linear-discord-webhook](.github/banner.png)

# Linear Discord Webhook

Receive Linear updates directly in your Discord channels.

This is a Cloudflare Worker that ingests Linear webhooks (issue creates, comments on issues and on project status updates, and project status updates themselves) and forwards them into a Discord channel as embeds.

## About this fork

This is a self-hostable fork of screfy/linear-discord-webhook. We are **not** running a hosted service — if you want to use this, you deploy your own copy to your own Cloudflare account. All credit for the original implementation goes to @screfy; we're just open-sourcing the version we run internally.

What this fork changes vs upstream:

- **Runs as a Cloudflare Worker** instead of a Vercel serverless function. This was the main reason for the fork.
- **HMAC signature verification is enforced**, layered on top of upstream's existing source-IP allowlist. Every incoming webhook must carry a valid `Linear-Signature` header and a `webhookTimestamp` within 60 seconds of now (replay protection); failures return `401`. The `LINEAR_WEBHOOK_SECRET` environment variable is required in production — set it via `wrangler secret put`.
- **No hosted UI.** The upstream project has a companion site (`ldw.screfy.com`) that generates your webhook URL via a form. This fork does not ship or host that UI — **you craft the URL yourself.** See [Crafting your webhook URL](#crafting-your-webhook-url) below.

## Deployment

Prerequisites:

- A Cloudflare account with Workers enabled.
- The Wrangler CLI installed globally (`npm i -g wrangler`) or available via `npx wrangler`.
- A Discord channel with a webhook.
- A Linear API token.
- A Linear webhook (created below) with its signing secret.

Clone and deploy:

```sh
git clone <your-fork-url>
cd linear-discord-webhook

# Set the Linear webhook signing secret (found on the webhook's detail page in Linear).
# This is required in production; requests without a valid signature are rejected with 401.
wrangler secret put LINEAR_WEBHOOK_SECRET

wrangler deploy
```

Wrangler will print your deployed URL, e.g. `https://linear-discord-webhook.<your-subdomain>.workers.dev`. You'll plug this into Linear in the next step.

## Crafting your webhook URL

Because there's no hosted UI, you build the Linear webhook URL by hand. The Worker accepts three query parameters:

| Parameter      | Where it comes from                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `webhookId`    | The **numeric** segment of your Discord webhook URL. From `https://discord.com/api/webhooks/1234567890/abc-xyz`, this is `1234567890`. |
| `webhookToken` | The **alphanumeric** segment after the ID. From the URL above, this is `abc-xyz`.                                                      |
| `linearToken`  | Your Linear API token (starts with `lin_api_…`). Create one at linear.app/settings/api.                                                |

Assemble the URL like so:

```
https://<your-worker-url>/?webhookId=<id>&webhookToken=<token>&linearToken=<lin_api_…>
```

Smoke-test it locally first. `wrangler dev` starts a local Worker on `http://localhost:8787`, which bypasses the signature/IP/timestamp checks (see [Local development](#local-development)):

```sh
curl -i -X POST "http://localhost:8787/?webhookId=1234567890&webhookToken=abc-xyz&linearToken=lin_api_..."
```

Once deployed, the production URL looks like:

```
https://linear-discord-webhook.<your-subdomain>.workers.dev/?webhookId=1234567890&webhookToken=abc-xyz&linearToken=lin_api_...
```

Then register it in Linear:

1. Go to **Linear → Settings → API → Webhooks**.
2. Create a new webhook and paste the URL above into the **URL** field.
3. Subscribe to the **Issue**, **Comment**, and **Project update** event types. Comments on project status updates arrive under the same **Comment** event as issue comments — Linear distinguishes them via the parent in the payload, not via a separate event type.
4. Copy the **signing secret** shown on the webhook detail page into the Worker via `wrangler secret put LINEAR_WEBHOOK_SECRET` (if you haven't already).

## Security checks

Every incoming webhook is verified against three independent checks (all enforced in production, all bypassed when `ENVIRONMENT=development`):

1. **Source IP** — must match one of Linear's published webhook IPs via the `CF-Connecting-IP` header (set by Cloudflare's edge, cannot be spoofed by the caller).
2. **HMAC signature** — the `Linear-Signature` header is verified against `HMAC-SHA256(rawBody, LINEAR_WEBHOOK_SECRET)` using Web Crypto's timing-safe `subtle.verify`.
3. **Timestamp** — `webhookTimestamp` in the body must be within 60 seconds of the Worker's clock, to guard against replay attacks.

If any check fails, the request is rejected with `401` (or `403` for IP rejection) before any Discord forwarding occurs.

## Optional: status-change notifications

Linear sends a webhook whenever an issue's status changes (e.g. Todo → In Progress). Upstream forwards these to Discord by default; this fork **disables them by default** to keep channels quieter, but the code path is preserved.

To opt in, set `NOTIFY_STATUS_CHANGES` to the literal string `"true"` as a Worker var — easiest via a `[vars]` block in `wrangler.toml`:

```toml
[vars]
NOTIFY_STATUS_CHANGES = "true"
```

Any other value (including unset) leaves status changes silently skipped. In the default configuration, the events that fire Discord embeds are: issue _creates_, comment _creates_ (both on issues and on project status updates), and project-status-update _creates_.

## Local development

`wrangler dev` starts a local Worker. All three security checks above are bypassed when `ENVIRONMENT=development` (set in `.dev.vars`), which lets you `curl` the Worker directly without signing requests. **Do not set `ENVIRONMENT=development` in production.**

A minimal `.dev.vars`:

```
ENVIRONMENT=development
```

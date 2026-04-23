import { Buffer } from 'node:buffer';
import { EmbedBuilder } from '@discordjs/builders';
import { LinearClient } from '@linear/sdk';
import { z, ZodError } from 'zod';
import { HttpError } from '../lib/HttpError';
import { SCHEMA } from '../lib/schema';
import { Action, Model } from '../lib/schema/utils';

const DISCORD_WEBHOOKS_URL = 'https://discord.com/api/webhooks';

const WEBHOOK_USERNAME = 'Linear';

const LINEAR_BASE_URL = 'https://linear.app';
const LINEAR_COLOR = 0x5e6ad2;
const LINEAR_TRUSTED_IPS = z.enum([
	'35.231.147.226',
	'35.243.134.228',
	'34.140.253.14',
	'34.38.87.206',
	'34.134.222.122',
	'35.222.25.142'
]);
// Source: https://linear.app/developers/webhooks#securing-webhooks
const MAX_CLOCK_SKEW_MS = 60 * 1000;

const QUERY_SCHEMA = z.object({
	webhookId: z.string(),
	webhookToken: z.string(),
	linearToken: z.string()
});

interface Env {
	ENVIRONMENT?: string;
	LINEAR_WEBHOOK_SECRET?: string;
	// Opt-in flag for issue status-change notifications. Set to "true" to
	// forward Linear status updates (e.g. Todo → In Progress) to Discord.
	// Unset / any other value → status changes are silently dropped.
	NOTIFY_STATUS_CHANGES?: string;
}

function parseIdentifier(url: string) {
	return url.split('/')[5].split('#')[0];
}

// Linear renders bare URLs the user typed as masked links where the
// display text is the URL itself — `[url](url)` or the CommonMark
// angle-bracket variant `[url](<url>)`. Discord can't render either:
// its auto-linker consumes the inner URL before the masked-link parser
// runs, leaving the orphaned `[](...)` syntax as literal text. Unwrap
// to the bare URL so Discord's auto-linker handles it normally.
function unwrapLinearAutoLinks(text: string): string {
	return text.replace(/\[\s*(https?:\/\/[^\s\]]+)\s*\]\(<?\1>?\)/g, '$1');
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

async function verifyLinearSignature(
	secret: string,
	rawBody: ArrayBuffer,
	headerSignature: string | null
): Promise<boolean> {
	if (!headerSignature) return false;
	const sigBytes = Buffer.from(headerSignature, 'hex');

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);
	return crypto.subtle.verify('HMAC', key, sigBytes, rawBody);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const isDev = env.ENVIRONMENT === 'development';

			// Allow only `POST` method:
			if (request.method !== 'POST') {
				throw new HttpError(`Method ${request.method} is not allowed.`, 405);
			}

			// 1. IP allowlist (fast reject; bypassed in dev):
			const ip = request.headers.get('cf-connecting-ip') ?? '';
			const { success: ipOk } = LINEAR_TRUSTED_IPS.safeParse(ip);
			if (!isDev && !ipOk) {
				throw new HttpError(
					`Request from IP address ${ip} is not allowed.`,
					403
				);
			}

			// 2. HMAC signature over the raw body (bypassed in dev):
			const rawBody = await request.arrayBuffer();
			if (!isDev) {
				if (!env.LINEAR_WEBHOOK_SECRET) {
					throw new HttpError(
						'Server misconfigured: LINEAR_WEBHOOK_SECRET is not set.',
						500
					);
				}
				const signatureOk = await verifyLinearSignature(
					env.LINEAR_WEBHOOK_SECRET,
					rawBody,
					request.headers.get('linear-signature')
				);
				if (!signatureOk) {
					throw new HttpError('Invalid signature.', 401);
				}
			}

			const parsedBody = JSON.parse(new TextDecoder().decode(rawBody));

			// 3. Timestamp freshness (replay protection; bypassed in dev):
			if (!isDev) {
				const ts = parsedBody?.webhookTimestamp;
				if (
					typeof ts !== 'number' ||
					Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS
				) {
					throw new HttpError('Webhook timestamp is stale or missing.', 401);
				}
			}

			const searchParams = new URL(request.url).searchParams;
			const { webhookId, webhookToken, linearToken } = QUERY_SCHEMA.parse({
				webhookId: searchParams.get('webhookId'),
				webhookToken: searchParams.get('webhookToken'),
				linearToken: searchParams.get('linearToken')
			});
			const result = SCHEMA.safeParse(parsedBody);

			// Prevent Linear repeating requests for not supported resources:
			if (!result.success) {
				return json({
					success: true,
					message: 'Event skipped.',
					error: null
				});
			}

			const body = result.data;
			const embed = new EmbedBuilder()
				.setColor(LINEAR_COLOR)
				.setTimestamp(new Date(body.createdAt));
			const linear = new LinearClient({ apiKey: linearToken });
			let shouldNotify = false;

			switch (body.type) {
				case Model.ISSUE: {
					if (body.action === Action.CREATE) {
						const creator = await linear.user(body.data.creatorId);
						const identifier = parseIdentifier(body.url);
						const teamUrl = `${LINEAR_BASE_URL}/team/${body.data.team.key}`;

						embed
							.setTitle(`${identifier} ${body.data.title}`)
							.setURL(body.url)
							.setAuthor({ name: 'New issue added' })
							.setFooter({
								text: creator.name,
								iconURL: creator.avatarUrl ?? undefined
							})
							.addFields(
								{
									name: 'Team',
									value: `[${body.data.team.name}](${teamUrl})`,
									inline: true
								},
								{ name: 'Status', value: body.data.state.name, inline: true }
							);

						if (body.data.assignee) {
							const assignee = await linear.user(body.data.assignee.id);

							embed.addFields({
								name: 'Assignee',
								value: `[${assignee.displayName}](${assignee.url})`,
								inline: true
							});
						}

						if (body.data.description) {
							embed.setDescription(
								unwrapLinearAutoLinks(body.data.description)
							);
						}
						shouldNotify = true;
					} else if (
						env.NOTIFY_STATUS_CHANGES === 'true' &&
						body.action === Action.UPDATE &&
						body.updatedFrom?.stateId
					) {
						const creator = await linear.user(body.data.creatorId);
						const identifier = parseIdentifier(body.url);

						embed
							.setTitle(`${identifier} ${body.data.title}`)
							.setURL(body.url)
							.setAuthor({ name: 'Status changed' })
							.setColor(parseInt(body.data.state.color.replace('#', ''), 16))
							.setFooter({
								text: creator.name,
								iconURL: creator.avatarUrl ?? undefined
							})
							.setDescription(`Status: **${body.data.state.name}**`);
						shouldNotify = true;
					}

					break;
				}
				case Model.COMMENT: {
					if (body.action === Action.CREATE) {
						const user = await linear.user(body.data.userId);
						const identifier = parseIdentifier(body.url);

						embed
							.setTitle(`${identifier} ${body.data.issue.title}`)
							.setURL(body.url)
							.setAuthor({ name: 'New comment' })
							.setFooter({
								text: user.name,
								iconURL: user.avatarUrl ?? undefined
							})
							.setDescription(unwrapLinearAutoLinks(body.data.body));
						shouldNotify = true;
					}

					break;
				}
			}

			if (!shouldNotify) {
				return json({ success: true, message: 'Event skipped.', error: null });
			}

			const webhookUrl = `${DISCORD_WEBHOOKS_URL}/${webhookId}/${webhookToken}`;

			await fetch(webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					username: WEBHOOK_USERNAME,
					embeds: [embed.toJSON()]
				})
			});

			return json({ success: true, message: 'OK', error: null });
		} catch (e) {
			let error: string | z.core.$ZodIssue[] = 'Something went wrong.';
			let statusCode = 500;

			if (e instanceof HttpError) {
				error = e.message;
				statusCode = e.statusCode;
			} else if (e instanceof ZodError) {
				error = e.issues;
				statusCode = 400;
			}

			return json({ success: false, message: null, error }, statusCode);
		}
	}
};

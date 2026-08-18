export interface Env {
	PAGERDUTY_ROUTING_KEY: string;
	CF_WEBHOOK_SECRET: string;
	PAGERDUTY_EVENTS_URL: string;
}

const PD_SEVERITIES = ["critical", "error", "warning", "info"] as const;
type PagerDutySeverity = (typeof PD_SEVERITIES)[number];

interface CloudflareAlertPayload {
	name?: string;
	text?: string;
	data?: Record<string, unknown>;
	ts?: string;
	account_id?: string;
	alert_type?: string;
	[key: string]: unknown;
}

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.byteLength !== bBytes.byteLength) {
		return !crypto.subtle.timingSafeEqual(aBytes, aBytes);
	}
	return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

function isAuthorized(request: Request, secret: string): boolean {
	const provided = request.headers.get("cf-webhook-auth") ?? "";
	return provided.length > 0 && timingSafeEqual(provided, secret);
}

function severityFor(alert: CloudflareAlertPayload): PagerDutySeverity {
	const raw = String(alert.data?.new_health ?? "").toLowerCase();
	if (raw === "healthy") return "info";
	if (raw === "unhealthy") return "critical";
	return "warning";
}

interface PagerDutyEvent {
	routing_key: string;
	event_action: "trigger";
	payload: {
		summary: string;
		source: string;
		severity: PagerDutySeverity;
		timestamp?: string;
		component?: string | null;
		custom_details?: unknown;
	};
}

function toPagerDutyEvent(
	alert: CloudflareAlertPayload,
	routingKey: string,
): PagerDutyEvent {
	const summary = (alert.text ?? alert.name ?? "Cloudflare alert").slice(
		0,
		1024,
	);
	return {
		routing_key: routingKey,
		event_action: "trigger",
		payload: {
			summary,
			source: alert.account_id
				? `cloudflare:${alert.account_id}`
				: "cloudflare",
			severity: severityFor(alert),
			timestamp: alert.ts,
			component: alert.alert_type,
			custom_details: alert,
		},
	};
}

function toPagerDutyEventFromException(
	item: TraceItem,
	exception: TraceException,
	routingKey: string,
): PagerDutyEvent {
	const scriptName = item.scriptName ?? "unknown-worker";
	return {
		routing_key: routingKey,
		event_action: "trigger",
		payload: {
			summary: `${scriptName}: ${exception.name}: ${exception.message}`.slice(
				0,
				1024,
			),
			source: `cloudflare-worker:${scriptName}`,
			severity: "error",
			timestamp: new Date(exception.timestamp).toISOString(),
			component: scriptName,
			custom_details: {
				exceptionName: exception.name,
				exceptionMessage: exception.message,
				stack: exception.stack,
				outcome: item.outcome,
				eventTimestamp: item.eventTimestamp,
			},
		},
	};
}

async function sendPagerDutyEvent(
	event: PagerDutyEvent,
	env: Env,
): Promise<Response> {
	return fetch(env.PAGERDUTY_EVENTS_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
	});
}

async function forwardToPagerDuty(
	alert: CloudflareAlertPayload,
	env: Env,
): Promise<Response> {
	const event = toPagerDutyEvent(alert, env.PAGERDUTY_ROUTING_KEY);
	return sendPagerDutyEvent(event, env);
}

async function forwardExceptionsToPagerDuty(
	events: TraceItem[],
	env: Env,
): Promise<void> {
	const sends = events.flatMap((item) =>
		item.exceptions.map(async (exception) => {
			const event = toPagerDutyEventFromException(
				item,
				exception,
				env.PAGERDUTY_ROUTING_KEY,
			);
			const response = await sendPagerDutyEvent(event, env);
			if (!response.ok) {
				const detail = await response.text();
				console.error(
					`PagerDuty rejected exception event: ${response.status} ${detail}`,
				);
			}
		}),
	);
	await Promise.all(sends);
}

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== "/webhook") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (!isAuthorized(request, env.CF_WEBHOOK_SECRET)) {
			return new Response("Unauthorized", { status: 401 });
		}

		const rawBody = await request.text();
		let alert: CloudflareAlertPayload;
		try {
			alert = JSON.parse(rawBody);
		} catch {
			return new Response("Invalid JSON payload", { status: 400 });
		}

		const pdResponse = await forwardToPagerDuty(alert, env);
		if (!pdResponse.ok) {
			const detail = await pdResponse.text();
			console.error(`PagerDuty rejected event: ${pdResponse.status} ${detail}`);
			return new Response("Failed to forward alert to PagerDuty", {
				status: 502,
			});
		}

		return new Response("Alert forwarded to PagerDuty", { status: 200 });
	},

	async tail(
		events: TraceItem[],
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		const withExceptions = events.filter((item) => item.exceptions.length > 0);
		if (withExceptions.length === 0) return;
		await forwardExceptionsToPagerDuty(withExceptions, env);
	},
} satisfies ExportedHandler<Env>;

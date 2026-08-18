import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const testEnv = {
	...env,
	PAGERDUTY_ROUTING_KEY: "test-routing-key",
	CF_WEBHOOK_SECRET: "test-webhook-secret",
	PAGERDUTY_EVENTS_URL: "https://events.pagerduty.com/v2/enqueue",
};

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
	return new Request("https://worker.example/webhook", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function run(request: Request) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("cloudflare alert -> pagerduty worker", () => {
	it("rejects unknown paths", async () => {
		const request = new Request("https://worker.example/other", {
			method: "POST",
		});
		const response = await run(request);
		expect(response.status).toBe(404);
	});

	it("rejects non-POST requests", async () => {
		const request = new Request("https://worker.example/webhook", {
			method: "GET",
		});
		const response = await run(request);
		expect(response.status).toBe(405);
	});

	it("rejects requests missing the auth header", async () => {
		const request = makeRequest({ name: "Test alert" });
		const response = await run(request);
		expect(response.status).toBe(401);
	});

	it("rejects requests with the wrong auth header", async () => {
		const request = makeRequest(
			{ name: "Test alert" },
			{ "cf-webhook-auth": "wrong-secret" },
		);
		const response = await run(request);
		expect(response.status).toBe(401);
	});

	it("rejects invalid JSON bodies", async () => {
		const request = makeRequest("not json", {
			"cf-webhook-auth": "test-webhook-secret",
		});
		const response = await run(request);
		expect(response.status).toBe(400);
	});

	it("forwards a valid alert to the PagerDuty Events API", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 202 }));
		vi.stubGlobal("fetch", fetchSpy);

		const request = makeRequest(
			{
				name: "Load balancer pool unhealthy",
				text: "Pool origin-1 is unhealthy",
				account_id: "acct123",
				alert_type: "load_balancing_health_alert",
				ts: "2026-08-18T00:00:00Z",
				data: { new_health: "Unhealthy" },
			},
			{ "cf-webhook-auth": "test-webhook-secret" },
		);

		const response = await run(request);

		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
		expect(calledUrl).toBe("https://events.pagerduty.com/v2/enqueue");
		const sentBody = JSON.parse(calledInit.body as string);
		expect(sentBody.routing_key).toBe("test-routing-key");
		expect(sentBody.event_action).toBe("trigger");
		expect(sentBody.payload.summary).toBe("Pool origin-1 is unhealthy");
		expect(sentBody.payload.source).toBe("cloudflare:acct123");
		expect(sentBody.payload.severity).toBe("critical");
		expect(sentBody.payload.component).toBe("load_balancing_health_alert");
	});

	it("returns 502 when PagerDuty rejects the event", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(new Response("bad routing key", { status: 400 })),
		);

		const request = makeRequest(
			{ name: "Test alert" },
			{ "cf-webhook-auth": "test-webhook-secret" },
		);
		const response = await run(request);
		expect(response.status).toBe(502);
	});
});

function makeTraceItem(overrides: Partial<TraceItem> = {}): TraceItem {
	return {
		event: null,
		eventTimestamp: 1755500000000,
		logs: [],
		exceptions: [],
		diagnosticsChannelEvents: [],
		scriptName: "other-worker",
		outcome: "exception",
		executionModel: "stateless",
		truncated: false,
		cpuTime: 0,
		wallTime: 0,
		...overrides,
	};
}

describe("tail handler -> pagerduty", () => {
	it("ignores trace items with no exceptions", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const ctx = createExecutionContext();
		await worker.tail?.([makeTraceItem()], testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("forwards each exception from other workers to PagerDuty", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 202 }));
		vi.stubGlobal("fetch", fetchSpy);

		const item = makeTraceItem({
			scriptName: "cookie-worker",
			exceptions: [
				{
					name: "TypeError",
					message: "Cannot read properties of undefined",
					timestamp: 1755500000000,
					stack: "TypeError: ...\n  at handler (index.js:1:1)",
				},
			],
		});

		const ctx = createExecutionContext();
		await worker.tail?.([item], testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
		expect(calledUrl).toBe("https://events.pagerduty.com/v2/enqueue");
		const sentBody = JSON.parse(calledInit.body as string);
		expect(sentBody.routing_key).toBe("test-routing-key");
		expect(sentBody.event_action).toBe("trigger");
		expect(sentBody.payload.summary).toBe(
			"cookie-worker: TypeError: Cannot read properties of undefined",
		);
		expect(sentBody.payload.source).toBe("cloudflare-worker:cookie-worker");
		expect(sentBody.payload.severity).toBe("error");
		expect(sentBody.payload.custom_details.exceptionName).toBe("TypeError");
	});

	it("sends one PagerDuty event per exception across multiple trace items", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 202 }));
		vi.stubGlobal("fetch", fetchSpy);

		const items = [
			makeTraceItem({
				scriptName: "worker-a",
				exceptions: [
					{ name: "Error", message: "boom", timestamp: 1755500000000 },
				],
			}),
			makeTraceItem({
				scriptName: "worker-b",
				exceptions: [
					{ name: "RangeError", message: "oops", timestamp: 1755500001000 },
					{ name: "Error", message: "again", timestamp: 1755500002000 },
				],
			}),
		];

		const ctx = createExecutionContext();
		await worker.tail?.(items, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("logs but does not throw when PagerDuty rejects an exception event", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(new Response("bad routing key", { status: 400 })),
		);
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const item = makeTraceItem({
			exceptions: [
				{ name: "Error", message: "boom", timestamp: 1755500000000 },
			],
		});

		const ctx = createExecutionContext();
		await expect(worker.tail?.([item], testEnv, ctx)).resolves.toBeUndefined();
		await waitOnExecutionContext(ctx);

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("PagerDuty rejected exception event: 400"),
		);
		consoleErrorSpy.mockRestore();
	});
});

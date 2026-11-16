import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** The ChatGPT failures a second connection can cover: plan limit, outage, cut-off response. */
const RETRYABLE = /usage limit reached|request failed|incomplete response/i;

/**
 * Forward `primary`. If it fails with a retryable error before any content
 * reached the caller, and `eligible()` holds, run `fallback()` instead.
 * `fallback` resolving undefined keeps the original error.
 */
export function withFallback(
	primary: AsyncIterable<AssistantMessageEvent>,
	eligible: () => boolean,
	fallback: () => Promise<AsyncIterable<AssistantMessageEvent> | undefined>,
): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	void (async () => {
		const held: AssistantMessageEvent[] = [];
		let flowing = false;
		try {
			for await (const event of primary) {
				if (!flowing && event.type === "start") { held.push(event); continue; }
				if (!flowing && event.type === "error" && event.reason === "error" && RETRYABLE.test(event.error.errorMessage ?? "") && eligible()) {
					const next = await fallback().catch(() => undefined);
					if (next) { for await (const fallbackEvent of next) output.push(fallbackEvent); return; }
				}
				if (!flowing) { flowing = true; for (const start of held) output.push(start); }
				output.push(event);
			}
		} finally { output.end(); }
	})();
	return output;
}

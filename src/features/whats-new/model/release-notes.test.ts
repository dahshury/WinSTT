import { afterEach, describe, expect, test } from "bun:test";
import {
	readLastSeenVersion,
	WHATS_NEW_LAST_SEEN_KEY,
	writeLastSeenVersion,
} from "./release-notes";

describe("what's-new version gate", () => {
	afterEach(() => {
		globalThis.localStorage?.removeItem(WHATS_NEW_LAST_SEEN_KEY);
	});

	test("persists and reads the dismissed app version", () => {
		writeLastSeenVersion("0.1.3-alpha.6");

		expect(readLastSeenVersion()).toBe("0.1.3-alpha.6");
	});
});

// Ambient augmentations for DOM APIs that ship in our target Chromium but are
// not yet in the bundled TypeScript `lib.dom.d.ts`.
//
// Chromium M114+ exposes per-context audio output-device routing: a `sinkId`
// option on the `AudioContext` constructor and a `setSinkId()` method on the
// instance. lib.dom hasn't adopted them, so historically call sites cast with
// `… as unknown as AudioContextOptions`. Declaring the real shape here lets the
// compiler accept `new AudioContext({ sinkId })` and `ctx.setSinkId(...)`
// directly — the runtime API is the source of truth, not a stale lib.
//
// See: https://developer.chrome.com/blog/audiocontext-setsinkid/
export {};

declare global {
	interface AudioContextOptions {
		/** Output device id (Chromium M114+). Empty/absent = system default. */
		sinkId?: string | { type: "none" };
	}

	interface AudioContext {
		/** Reroute a live context to another output device (Chromium M114+). */
		setSinkId?: (id: string | { type: "none" }) => Promise<void>;
	}
}

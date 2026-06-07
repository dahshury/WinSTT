import { useCallback, useEffect, useRef, useState } from "react";
import { soundLibraryReadFile } from "@/shared/api/ipc-client";
import {
  createOutputContext,
  routeContextToSink,
  toArrayBuffer,
} from "@/shared/lib/web-audio";

interface UseSoundPreviewReturn {
  /** Path/id of the currently-playing sound, or null when idle. */
  playingId: string | null;
  /** Toggle preview playback. Calling with the currently-playing id stops it. */
  toggle: (id: string, path: string, outputDeviceId?: string) => Promise<void>;
}

async function decode(
  ctx: AudioContext,
  bytes: Uint8Array,
): Promise<AudioBuffer | null> {
  try {
    return await ctx.decodeAudioData(toArrayBuffer(bytes));
  } catch {
    return null;
  }
}

/** Fetch the raw bytes for a clip: empty path, builtin:<file>, or custom file path. */
function fetchBytes(path: string): Promise<Uint8Array | null> {
  return soundLibraryReadFile(path);
}

/** Fetch + decode a clip's bytes. Returns null if missing or undecodable. */
async function fetchAndDecode(
  ctx: AudioContext,
  path: string,
): Promise<AudioBuffer | null> {
  const bytes = await fetchBytes(path);
  if (!bytes) {
    return null;
  }
  return decode(ctx, bytes);
}

/**
 * Resolve the decoded buffer for an id: cache hit short-circuits, otherwise
 * fetch → decode → cache. Pulled out of `play` so the playback path stays
 * low-complexity.
 */
async function resolveBuffer(
  ctx: AudioContext,
  cache: Map<string, AudioBuffer>,
  id: string,
  path: string,
): Promise<AudioBuffer | null> {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const decoded = await fetchAndDecode(ctx, path);
  if (decoded) {
    cache.set(id, decoded);
  }
  return decoded;
}

/**
 * Plays a single sound at a time. Caches decoded buffers per-id so repeated
 * previews of the same clip don't re-fetch the file. The Web Audio context
 * is shared across previews and torn down on unmount.
 */
export function useSoundPreview(): UseSoundPreviewReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const outputDeviceIdRef = useRef<string>("");
  const cacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(
    () => () => {
      sourceRef.current?.stop();
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      ctxRef.current?.close();
      ctxRef.current = null;
      cacheRef.current.clear();
    },
    [],
  );

  const ensureContext = useCallback(
    async (outputDeviceId = ""): Promise<AudioContext> => {
      if (!ctxRef.current) {
        ctxRef.current = createOutputContext(outputDeviceId);
        outputDeviceIdRef.current = outputDeviceId;
      } else if (outputDeviceIdRef.current !== outputDeviceId) {
        await routeContextToSink(ctxRef.current, outputDeviceId);
        outputDeviceIdRef.current = outputDeviceId;
      }

      if (ctxRef.current.state === "suspended") {
        await ctxRef.current.resume();
      }
      return ctxRef.current;
    },
    [],
  );

  const stop = useCallback(() => {
    sourceRef.current?.stop();
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    setPlayingId(null);
  }, []);

  const play = useCallback(
    async (id: string, path: string, outputDeviceId = ""): Promise<void> => {
      const ctx = await ensureContext(outputDeviceId);
      const buffer = await resolveBuffer(ctx, cacheRef.current, id, path);
      if (!buffer) {
        return;
      }
      stop();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        // Only clear state if this source is still the active one — if a
        // new preview started before the previous one finished, its onended
        // would otherwise clobber the new playingId.
        if (sourceRef.current === source) {
          sourceRef.current = null;
          setPlayingId(null);
        }
      };
      sourceRef.current = source;
      setPlayingId(id);
      source.start();
    },
    [ensureContext, stop],
  );

  const toggle = useCallback(
    async (id: string, path: string, outputDeviceId = ""): Promise<void> => {
      if (playingId === id) {
        stop();
        return;
      }
      await play(id, path, outputDeviceId);
    },
    [play, playingId, stop],
  );

  return { playingId, toggle };
}

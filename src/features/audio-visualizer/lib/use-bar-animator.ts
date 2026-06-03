import type { AgentState } from "./audio-visualizer";
import { useSequenceAnimator } from "./use-sequence-animator";

function generateConnectingSequence(columns: number): number[][] {
  const seq: number[][] = [];
  for (let x = 0; x < columns; x++) {
    seq.push([x, columns - 1 - x]);
  }
  return seq;
}

function generateListeningSequence(columns: number): number[][] {
  const center = Math.floor(columns / 2);
  return [[center], [-1]];
}

function generateSpeakingSequence(columns: number): number[][] {
  return [new Array(columns).fill(0).map((_, idx) => idx)];
}

// Dispatch table keeps buildSequence at CC=2 (just the `??` fallback) instead
// of a ladder of `if`s. New states only need a row here.
const SEQUENCE_BUILDERS: Partial<
  Record<AgentState, (columns: number) => number[][]>
> = {
  speaking: generateSpeakingSequence,
  listening: generateListeningSequence,
  thinking: generateListeningSequence,
  connecting: generateConnectingSequence,
  initializing: generateConnectingSequence,
};

function buildSequence(state: AgentState, columns: number): number[][] {
  return SEQUENCE_BUILDERS[state]?.(columns) ?? [[]];
}

export function useBarAnimator(
  state: AgentState,
  columns: number,
  interval: number,
): number[] {
  return useSequenceAnimator(
    buildSequence(state, columns),
    `${state}:${columns}`,
    interval,
  );
}

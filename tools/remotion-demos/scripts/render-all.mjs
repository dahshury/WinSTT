import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const outDir = join(projectRoot, "..", "..", "docs", "public", "demos");

const ids = [
  "main",
  "ptt",
  "toggle",
  "listen",
  "wakeword",
  "llm-dictation",
  "llm-transform",
  "auto-submit",
  "dictionary",
  "snippets",
  "transcribe-file",
  "viz-bar",
  "viz-grid",
  "viz-radial",
  "viz-wave",
  "viz-aura",
  "overlay-floating",
  "overlay-island",
  "dictation-loop",
  "model-picker-flow",
  "audio-vad-flow",
  "quality-pipeline",
  "integrations-secrets",
  "tts-voice-flow",
  "history-playback",
  "architecture-flow"
];

mkdirSync(outDir, { recursive: true });

const remotionBin = process.platform === "win32"
  ? join(projectRoot, "node_modules", ".bin", "remotion.cmd")
  : join(projectRoot, "node_modules", ".bin", "remotion");

for (const id of ids) {
  const output = join(outDir, `${id}.webm`);
  console.log(`\nRendering ${id} -> ${output}`);
  const result = spawnSync(
    remotionBin,
    [
      "render",
      "src/index.tsx",
      id,
      output,
      "--codec=vp9",
      "--crf=20",
      "--overwrite",
      "--concurrency=50%"
    ],
    {
      cwd: projectRoot,
      stdio: "inherit",
      shell: process.platform === "win32"
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

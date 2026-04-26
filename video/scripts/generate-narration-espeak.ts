// Offline narration fallback using espeak-ng + ffmpeg.
// Used when ElevenLabs isn't reachable. Produces the same per-scene MP3
// layout and manifest.json as the ElevenLabs generator so the Remotion
// composition can consume either.
//
// Quality is modest — espeak is robotic — but it's a real voice-over
// you can stand up offline.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SCRIPT, type SceneId } from "../src/narration";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const NARRATION_DIR = join(PROJECT_ROOT, "public", "narration");

type ManifestEntry = { id: SceneId; file: string; durationSeconds: number };

function probeDurationSeconds(file: string): number {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ],
    { encoding: "utf8" },
  );
  return Number.parseFloat(out.trim());
}

function synthesise(text: string, mp3Path: string): void {
  const wav = join(tmpdir(), `narr-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  // Slow, lowered pitch, small inter-word gap — closest espeak can come
  // to a documentary-style male voice.
  execFileSync("espeak-ng", [
    "-v", "en-us+m3",
    "-s", "155",
    "-p", "30",
    "-g", "6",
    "-w", wav,
    text,
  ]);
  // 128 kbit/s mono CBR, 44.1 kHz — matches the ElevenLabs path.
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", wav,
    "-ac", "1",
    "-ar", "44100",
    "-b:a", "128k",
    mp3Path,
  ]);
  execFileSync("rm", ["-f", wav]);
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await mkdir(NARRATION_DIR, { recursive: true });
  const force = process.argv.includes("--force");
  const manifest: ManifestEntry[] = [];

  for (const scene of SCRIPT) {
    const file = join(NARRATION_DIR, `${scene.id}.mp3`);
    if (force || !(await exists(file))) {
      process.stdout.write(`  · ${scene.id} … `);
      synthesise(scene.text, file);
      process.stdout.write("done\n");
    } else {
      process.stdout.write(`  · ${scene.id} (cached)\n`);
    }
    const durationSeconds = probeDurationSeconds(file);
    manifest.push({ id: scene.id, file: `narration/${scene.id}.mp3`, durationSeconds });
  }

  await writeFile(
    join(NARRATION_DIR, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), scenes: manifest }, null, 2),
  );

  const total = manifest.reduce((s, m) => s + m.durationSeconds, 0);
  console.log(`\n  manifest written. total runtime ≈ ${total.toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

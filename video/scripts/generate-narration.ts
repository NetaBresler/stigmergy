// Generates per-scene narration MP3s via the ElevenLabs text-to-speech API,
// then writes a manifest.json with each scene's measured duration so the
// Remotion Composition can size scenes to match the audio.
//
// Requires:
//   ELEVENLABS_API_KEY=...    (in env or video/.env)
//   ELEVENLABS_VOICE_ID=...   (optional, defaults to "George")
//
// Usage:
//   npm run narrate

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT, type SceneId } from "../src/narration";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const NARRATION_DIR = join(PROJECT_ROOT, "public", "narration");
const ENV_PATH = join(PROJECT_ROOT, ".env");

// Minimal .env loader so we don't pull in dotenv just for this.
async function loadDotenv(): Promise<void> {
  try {
    const raw = await readFile(ENV_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      if (process.env[key]) continue;
      const val = rawVal.replace(/^["']|["']$/g, "");
      process.env[key] = val;
    }
  } catch {
    // No .env file. Fine — env may be set externally.
  }
}

// MP3 frame durations summed by scanning frame headers. Avoids depending
// on ffprobe being installed. Handles MPEG 1/2/2.5 Layer III (the format
// ElevenLabs returns for mp3 output).
function measureMp3DurationSeconds(buf: Buffer): number {
  // Skip ID3v2 tag if present.
  let i = 0;
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    i = 10 + size;
  }

  const v1l3Bitrates = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
  ];
  const v2l3Bitrates = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
  ];
  const v1Rates = [44100, 48000, 32000];
  const v2Rates = [22050, 24000, 16000];
  const v25Rates = [11025, 12000, 8000];

  let totalSamples = 0;
  let lastSampleRate = 44100;

  while (i < buf.length - 4) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const versionBits = (buf[i + 1] >> 3) & 0x03; // 0=v2.5, 2=v2, 3=v1
    const layerBits = (buf[i + 1] >> 1) & 0x03;   // 1=L3, 2=L2, 3=L1
    const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
    const sampleIdx = (buf[i + 2] >> 2) & 0x03;
    const padding = (buf[i + 2] >> 1) & 0x01;
    if (layerBits !== 1 || versionBits === 1 || bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) {
      i++;
      continue;
    }
    const isV1 = versionBits === 3;
    const bitrate = (isV1 ? v1l3Bitrates[bitrateIdx] : v2l3Bitrates[bitrateIdx]) * 1000;
    const sampleRate = (versionBits === 3 ? v1Rates : versionBits === 2 ? v2Rates : v25Rates)[sampleIdx];
    const samplesPerFrame = isV1 ? 1152 : 576;
    const frameLen = Math.floor(((isV1 ? 144 : 72) * bitrate) / sampleRate) + padding;
    if (frameLen < 4) {
      i++;
      continue;
    }
    totalSamples += samplesPerFrame;
    lastSampleRate = sampleRate;
    i += frameLen;
  }
  return totalSamples / lastSampleRate;
}

type ManifestEntry = { id: SceneId; file: string; durationSeconds: number };

async function fetchScene(
  apiKey: string,
  voiceId: string,
  text: string,
): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        // eleven_v3 (alpha) — more expressive, better prosody for explainer narration.
        model_id: "eleven_v3",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 500)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function alreadyHave(file: string): Promise<boolean> {
  try {
    const s = await stat(file);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await loadDotenv();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // Default voice: "Brian" — calm, deep, narrator-style. Fits the contemplative
  // tone of the explainer better than a conversational voice.
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "nPczCjzI2devNBz1zQrb";
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not set. Copy video/.env.example to video/.env and fill it in.",
    );
  }

  await mkdir(NARRATION_DIR, { recursive: true });

  const force = process.argv.includes("--force");
  const manifest: ManifestEntry[] = [];

  for (const scene of SCRIPT) {
    const file = join(NARRATION_DIR, `${scene.id}.mp3`);
    let buf: Buffer;
    if (!force && (await alreadyHave(file))) {
      buf = await readFile(file);
      process.stdout.write(`  · ${scene.id} (cached)\n`);
    } else {
      process.stdout.write(`  · ${scene.id} … `);
      buf = await fetchScene(apiKey, voiceId, scene.text);
      await writeFile(file, buf);
      process.stdout.write("done\n");
    }
    const durationSeconds = measureMp3DurationSeconds(buf);
    manifest.push({
      id: scene.id,
      file: `narration/${scene.id}.mp3`,
      durationSeconds,
    });
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

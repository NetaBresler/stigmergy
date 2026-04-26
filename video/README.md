# Stigmergy explainer video

A ~90-second Remotion video that walks through the Stigmergy thesis: why hierarchical multi-agent systems plateau, what stigmergy is, and the six primitives that define the framework. Voice-over is generated from the script with ElevenLabs text-to-speech.

The script and the visuals are driven from a single source of truth (`src/narration.ts`). The narration generator writes one MP3 per scene plus a `manifest.json` of measured durations, and the Remotion composition reads that manifest to size each scene to its audio.

## What you need

- Node 22+
- An ElevenLabs API key with TTS credit
- ~120 MB free for the Chrome Headless Shell that Remotion downloads on first render

## Render the video

```bash
cd video
npm install

# 1. Put your key in .env
cp .env.example .env
$EDITOR .env   # set ELEVENLABS_API_KEY

# 2. Generate per-scene narration (writes public/narration/*.mp3 + manifest.json)
npm run narrate

# 3. Render to out/stigmergy.mp4
npm run render
```

`npm run build` chains both steps.

The first render also pulls Chrome Headless Shell (~88 MB). Subsequent renders are cached.

## Render in GitHub Actions

There's a workflow at `.github/workflows/render-video.yml` that does the same thing on a runner — useful when you can't reach `api.elevenlabs.io` from your local environment.

1. Add a repo secret named `ELEVENLABS_API_KEY`.
2. Actions → **Render Stigmergy explainer** → **Run workflow**.
3. When it finishes, the MP4 is attached to a GitHub Release (`video-<run-number>`) and uploaded as a workflow artifact. The job summary prints both URLs.

## Iterate visually

```bash
npm run studio
```

Opens the Remotion Studio in a browser. Without a manifest, scenes use the fallback durations declared in `src/narration.ts` so you can preview visuals before generating audio.

## Editing the script

`src/narration.ts` is the only place to change wording or scene order. After editing:

```bash
npm run narrate -- --force   # re-fetch all scenes
```

`--force` overwrites cached MP3s; without it, only missing scenes are fetched.

## Choosing a different voice

Set `ELEVENLABS_VOICE_ID` in `.env`. The default is `JBFqnCBsd6RMkjVDRZzb` ("George"). Browse voices in the ElevenLabs voice library.

## Layout

```
video/
├── src/
│   ├── index.ts             registerRoot entry
│   ├── Root.tsx             registers the Composition
│   ├── Composition.tsx      timeline; reads manifest.json via calculateMetadata
│   ├── narration.ts         scene script + fallback durations (single source of truth)
│   ├── theme.ts             colors + fonts
│   └── scenes/              one component per scene
├── scripts/
│   └── generate-narration.ts  ElevenLabs client + MP3 duration measurer
└── public/narration/        generated MP3s + manifest.json (gitignored)
```

## Scenes

| # | Scene        | Beat                                                                           |
|---|--------------|--------------------------------------------------------------------------------|
| 1 | Title        | Stigmergy: coordinating agents without a manager                               |
| 2 | Hierarchy    | The manager-as-bottleneck pattern in current multi-agent frameworks            |
| 3 | Termites     | Grassé, 1959 — coordination without conversation                               |
| 4 | Principle    | *stigma* + *ergon* = work that guides work                                     |
| 5 | Medium       | The shared medium replaces the manager                                         |
| 6 | Decay        | Stale signals evaporate unless reinforced                                      |
| 7 | Primitives   | The six load-bearing primitives                                                |
| 8 | Claim        | Stop managing the agents. Shape the landscape they walk on.                    |

## Notes

- 1920×1080 at 30 fps. Change in `src/narration.ts`.
- The composition pads each scene by 0.6 s after the audio ends so visuals don't get clipped.
- MP3 duration is measured by parsing frame headers — no `ffprobe` dependency.
- `public/narration/*.mp3` and `manifest.json` are gitignored. Audio is reproducible from the script + your ElevenLabs account, so we keep it out of git to avoid bloating the repo with binary blobs.

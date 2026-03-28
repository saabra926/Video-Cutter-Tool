# CutFrame - Production Video Cutter

CutFrame is a browser-based video cutter built with Next.js + TypeScript.
It now includes stronger clip boundary handling, production-style export settings, and faster processing presets.

## What is fixed

- Precise start and end boundary lock
- Preview always stops at the selected end marker
- Export files now download with the real container extension (no fake `.mp4` naming)

## New production features

- Export format selection: `WEBM` or `MP4` (auto-fallback when browser codec support is limited)
- Speed profiles:
  - `FAST` for quick output
  - `BALANCED` for mixed quality/speed
  - `QUALITY` for higher bitrate output
- Optional audio toggle
- Cancel export button during processing
- Keyboard shortcuts:
  - `Space` play/pause
  - `J` / `L` seek -5s / +5s
  - `I` set start marker
  - `O` set end marker
- Real-time export stats:
  - output format + mime
  - processing speed factor (x realtime)
  - encode duration
- Estimated output size shown before export

## Performance improvements

- Optimized recorder chunk strategy by profile
- Throttled progress updates to reduce UI overhead
- Frame callback based progress monitor (with interval fallback)
- Better object URL cleanup to reduce memory pressure

## Tech stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Native browser processing (`captureStream` + `MediaRecorder`)

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Build

```bash
npm run build
npm start
```

## Notes

- Best compatibility is in latest Chrome or Edge.
- If your browser cannot encode MP4 directly, CutFrame falls back to WEBM automatically and clearly shows that in UI.
- Processing stays local in the browser; files are not uploaded.

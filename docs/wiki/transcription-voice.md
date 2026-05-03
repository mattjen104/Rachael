# Transcription & voice synthesis

## Transcription

Source: [`server/transcription-service.ts`](../../server/transcription-service.ts) (~269 lines)

- Sources: microphone (browser), tab capture (Chrome extension's
  `tabCapture`), uploaded file.
- API:
  - `POST /api/transcripts/record/start` (auth) — start a session.
  - `POST /api/transcripts/record/:sessionId/chunk` (auth) — stream PCM.
  - `POST /api/transcripts/record/:sessionId/stop` (auth) — finalize.
  - `POST /api/transcripts/upload` (auth) — multer upload, transcribe.
  - `GET  /api/transcripts` / `GET /api/transcripts/:id` — list/read.
- Persistence: `transcripts` table (raw text + per-segment timestamps,
  platform `teams|zoom|meet|other`, recording type `tab|mic|upload`).
- View: [`TranscriptsView.tsx`](../../client/src/components/views/TranscriptsView.tsx).

## Voice synthesis

Source: [`server/voice-synth.ts`](../../server/voice-synth.ts) (~73 lines)

- Uses `msedge-tts` (Microsoft Edge neural TTS).
- The morning briefing pipeline embeds `<!--VOICE_SCRIPT_START/END-->` in
  the LLM output; that block is extracted and synthesized to MP3.
- The MP3 is attached to the ntfy notification (NPR-style audio briefing).

## Voice command webhook

`POST /api/voice-cmd` (auth):

- Accepts `{text, source}`.
- Maps keywords to CLI commands (inbox/email, agenda, snow, standup, tasks,
  teams, citrix, memo/remember, search/find, notify).
- Executes via `cli-engine.executeChain`.
- Optionally pushes the result to ntfy.
- Unrecognized text is saved as a capture.

`POST /api/memo` (auth):

- Accepts `{text, source, tags}`.
- Saves as a note tagged `memo` + `voice`.
- Compatible with IFTTT `value1`/`value2` field shape.

## Voice view (browser-side)

[`client/src/components/views/VoiceView.tsx`](../../client/src/components/views/VoiceView.tsx)
uses the Web Speech API. Press `[V]`, speak, the recognized text is mapped
to a CLI command, executed, and the result is shown inline. Designed to be
usable from a Google TV with a Bluetooth keyboard.

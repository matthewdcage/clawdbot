# Qwen3 Voice Studio - Developer API Reference

**Version:** 5.1.0  
**Base URL:** `http://localhost:8880`  
**Protocol:** HTTP REST (JSON + multipart/form-data) + WebSocket  
**Audio Format:** WAV (PCM 16-bit, 48kHz, mono)  
**Last Updated:** 2026-02-17

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Endpoint Quick Reference](#endpoint-quick-reference)
3. [Quick Start](#quick-start)
4. [Authentication](#authentication)
5. [Environment Configuration (.env)](#environment-configuration)
6. [Response Headers](#response-headers)
7. [Error Handling](#error-handling)
8. [Endpoints Reference](#endpoints-reference)
   - [Health & Status](#health--status)
   - [Configuration & Defaults](#configuration--defaults)
   - [Model Lifecycle](#model-lifecycle)
   - [Voices & Languages](#voices--languages)
   - [Emotion / Style Presets](#emotion--style-presets)
   - [Text-to-Speech (Preset Voices)](#text-to-speech---preset-voices)
   - [WebSocket Streaming TTS](#websocket-streaming-tts)
   - [Text-to-Speech (Custom/Cloned Voices)](#text-to-speech---customcloned-voices)
   - [TTS Queue (Batch / Async)](#tts-queue)
   - [Speech-to-Text](#speech-to-text)
   - [Voice-to-Voice](#voice-to-voice)
   - [Custom Voice Management (CRUD)](#custom-voice-management)
   - [Model Management](#model-management)
   - [Outputs](#outputs)
9. [Integration Patterns](#integration-patterns)
   - [Python](#python)
   - [JavaScript / TypeScript](#javascript--typescript)
   - [Swift (iOS / macOS)](#swift-ios--macos)
   - [cURL](#curl)
10. [Deployed / Remote Access](#deployed--remote-access)
11. [Service Management](#service-management)
12. [Performance Notes](#performance-notes)
13. [Common Mistakes & Troubleshooting](#common-mistakes--troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Qwen3 Voice Studio (FastAPI)                           │
│  http://localhost:8880                                   │
│                                                         │
│  Lazy-Load Architecture:                                │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
│  │ Preset TTS│  │ Clone TTS │  │    STT    │           │
│  │  (~3 GB)  │  │  (~3 GB)  │  │ (~0.5 GB) │           │
│  │  1.7B     │  │  1.7B     │  │ Whisper   │           │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘           │
│        │  Load on demand │ Unload after│idle timeout    │
│  ──────┴────────────────┴─────────────┴──────           │
│                                                         │
│  ┌─────────────────────────────────────────────┐        │
│  │  TTS Queue Worker (background)              │        │
│  │  Sequential processing, priority ordering   │        │
│  │  Callback webhooks, auto-save outputs       │        │
│  └─────────────────────────────────────────────┘        │
│                                                         │
│  All config via .env with sensible defaults             │
│  Server process when idle: ~30-50 MB RAM                │
│  Server process with all models: ~6.5 GB RAM            │
└─────────────────────────────────────────────────────────┘
```

**Key Behaviours:**

- Server starts instantly with **zero models loaded**
- Models load **on first API request** that needs them (10-15s cold start)
- Subsequent requests are **instant** (models cached in RAM)
- After idle timeout (configurable), models auto-unload to free RAM
- Server process stays alive (instant re-load on next request)
- All defaults are configurable via `.env` file with hardcoded fallbacks

---

## Endpoint Quick Reference

> **IMPORTANT:** All TTS generation endpoints use `POST`. Only discovery/status endpoints use `GET`. There is NO `GET /v1/tts` or `GET /v1/speakers` endpoint.

| Method                      | Path                               | Content-Type                    | Description                                |
| --------------------------- | ---------------------------------- | ------------------------------- | ------------------------------------------ |
| **Status & Discovery**      |                                    |                                 |                                            |
| `GET`                       | `/health`                          | -                               | Health check (no auth, no model load)      |
| `GET`                       | `/v1/status`                       | -                               | Detailed status (models, RAM, idle timer)  |
| `GET`                       | `/v1/config`                       | -                               | Active configuration & defaults            |
| `GET`                       | `/v1/voices`                       | -                               | List all voices (preset + custom)          |
| `GET`                       | `/v1/languages`                    | -                               | List supported languages                   |
| `GET`                       | `/v1/emotions`                     | -                               | List emotion presets                       |
| `GET`                       | `/v1/outputs`                      | -                               | List saved output files                    |
| **Preset Voice TTS**        |                                    |                                 |                                            |
| `POST`                      | `/v1/tts`                          | `application/json`              | Generate speech (preset voice)             |
| `POST`                      | `/v1/tts/stream`                   | `application/json`              | Streaming TTS (preset voice)               |
| **Custom/Clone Voice TTS**  |                                    |                                 |                                            |
| `POST`                      | `/v1/tts/clone`                    | `multipart/form-data`           | Generate speech (custom voice) — form-data |
| `POST`                      | `/v1/tts/clone/json`               | `application/json`              | Generate speech (custom voice) — JSON      |
| `POST`                      | `/v1/tts/clone/stream`             | `multipart/form-data`           | Streaming TTS (custom voice) — form-data   |
| `POST`                      | `/v1/tts/clone/stream/json`        | `application/json`              | Streaming TTS (custom voice) — JSON        |
| **WebSocket TTS**           |                                    |                                 |                                            |
| `WS`                        | `/v1/tts/ws`                       | JSON config → binary PCM frames | Real-time streaming (preset or custom)     |
| **Queue (Async/Batch)**     |                                    |                                 |                                            |
| `POST`                      | `/v1/tts/queue`                    | `application/json`              | Submit TTS job                             |
| `GET`                       | `/v1/tts/queue`                    | -                               | List queue jobs                            |
| `GET`                       | `/v1/tts/queue/{job_id}`           | -                               | Check job status                           |
| `GET`                       | `/v1/tts/queue/{job_id}/audio`     | -                               | Download completed job audio               |
| `DELETE`                    | `/v1/tts/queue/{job_id}`           | -                               | Cancel queued job                          |
| **STT & Voice-to-Voice**    |                                    |                                 |                                            |
| `POST`                      | `/v1/stt`                          | `multipart/form-data`           | Transcribe audio to text                   |
| `POST`                      | `/v1/voice-to-voice`               | `multipart/form-data`           | Full STT → TTS pipeline                    |
| **Custom Voice Management** |                                    |                                 |                                            |
| `GET`                       | `/v1/custom-voices`                | -                               | List custom voices                         |
| `POST`                      | `/v1/custom-voices`                | `multipart/form-data`           | Create custom voice                        |
| `DELETE`                    | `/v1/custom-voices/{name}`         | -                               | Delete custom voice                        |
| `POST`                      | `/v1/custom-voices/{name}/preview` | `multipart/form-data`           | Preview custom voice                       |
| `GET`                       | `/v1/custom-voices/{name}/audio`   | -                               | Download reference audio                   |
| **Model Management**        |                                    |                                 |                                            |
| `GET`                       | `/v1/models`                       | -                               | List all model variants                    |
| `GET`                       | `/v1/models/active`                | -                               | Show active models per role                |
| `GET`                       | `/v1/models/{slug}`                | -                               | Get model details                          |
| `GET`                       | `/v1/models/downloads`             | -                               | List download progress                     |
| `POST`                      | `/v1/models/{slug}/download`       | -                               | Start model download                       |
| `DELETE`                    | `/v1/models/{slug}/download`       | -                               | Cancel download                            |
| `POST`                      | `/v1/models/{slug}/activate`       | `application/json`              | Activate model for role                    |
| `DELETE`                    | `/v1/models/{slug}`                | -                               | Delete model from disk                     |
| **Lifecycle**               |                                    |                                 |                                            |
| `POST`                      | `/v1/warmup`                       | `multipart/form-data`           | Pre-load models                            |
| `POST`                      | `/v1/unload`                       | -                               | Unload all models from RAM                 |

---

## Quick Start

### Start the server

```bash
cd qwen3-tts-apple-silicon
cp .env.example .env          # Optional: customise defaults
./service.sh install           # Installs as auto-start macOS service
```

Or manually:

```bash
source .venv/bin/activate
python server.py
```

### Generate speech with a preset voice

```bash
# Minimal request — uses .env defaults for speaker, emotion, etc.
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, how are you today?"}' \
  --output output.wav
```

### Generate speech with a custom (cloned) voice

```bash
# Option A: JSON endpoint (recommended for programmatic callers)
curl -X POST http://localhost:8880/v1/tts/clone/json \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, how are you today?", "voice_name": "Samantha2"}' \
  --output output.wav

# Option B: Form-data endpoint (used by web UI and multipart callers)
curl -X POST http://localhost:8880/v1/tts/clone \
  -F "voice_name=Samantha2" \
  -F "text=Hello, how are you today?" \
  --output output.wav
```

### List available voices

```bash
# GET /v1/voices — returns preset + custom voice lists
curl http://localhost:8880/v1/voices
```

### Queue multiple TTS jobs

```bash
# Submit job
curl -X POST http://localhost:8880/v1/tts/queue \
  -H "Content-Type: application/json" \
  -d '{"text": "First sentence", "emotion": "happy", "save_output": true}'

# Check status
curl http://localhost:8880/v1/tts/queue/abc12345

# Download audio when complete
curl http://localhost:8880/v1/tts/queue/abc12345/audio --output result.wav
```

### Check what defaults are active

```bash
curl http://localhost:8880/v1/config
```

---

## Authentication

**Default: None required.** The API runs locally with no authentication. CORS is fully open (`*`).

### Enabling API Key Auth

Set `VOICE_API_KEY` in your `.env`:

```bash
VOICE_API_KEY=my-secret-key-here
```

Then include the key in requests:

```bash
curl -H "X-API-Key: my-secret-key-here" http://localhost:8880/v1/voices
```

The `/health` endpoint is always accessible without auth. All other endpoints require the key when enabled.

---

## Environment Configuration

All server behaviour is configurable via a `.env` file in the project root. Copy `.env.example` to `.env` and edit as needed. Every setting has a sensible hardcoded fallback.

If `python-dotenv` is installed (`pip install python-dotenv`), the `.env` file is loaded automatically. Otherwise, set the values as system environment variables.

### Full Reference

| Variable                           | Default                                | Description                                                   |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| **Server**                         |                                        |                                                               |
| `VOICE_HOST`                       | `0.0.0.0`                              | Bind address                                                  |
| `VOICE_PORT`                       | `8880`                                 | Server port                                                   |
| `VOICE_API_KEY`                    | _(empty)_                              | API key for auth (empty = no auth)                            |
| `VOICE_STREAMING_ENABLED`          | `true`                                 | Master toggle for streaming endpoints (false = 503)           |
| `VOICE_LOG_LEVEL`                  | `INFO`                                 | Logging level (DEBUG, INFO, WARNING, ERROR)                   |
| **TTS Defaults**                   |                                        |                                                               |
| `VOICE_DEFAULT_SPEAKER`            | `ryan`                                 | Default preset voice when caller omits `speaker`              |
| `VOICE_DEFAULT_VOICE_NAME`         | _(empty)_                              | Default custom/cloned voice for clone endpoints               |
| `VOICE_DEFAULT_LANGUAGE`           | `auto`                                 | Default language code                                         |
| `VOICE_DEFAULT_TEMPERATURE`        | `0.7`                                  | Default generation randomness (0.1-1.5)                       |
| `VOICE_DEFAULT_SPEED`              | `1.0`                                  | Default speech speed multiplier (0.5-2.0)                     |
| `VOICE_DEFAULT_MAX_TOKENS`         | `4096`                                 | Default max generation tokens (256-8192)                      |
| `VOICE_DEFAULT_EMOTION`            | _(empty)_                              | Default emotion preset key (see `/v1/emotions`)               |
| `VOICE_DEFAULT_INSTRUCT`           | _(empty)_                              | Default freeform style instruction (used if emotion is empty) |
| `VOICE_DEFAULT_STREAMING_INTERVAL` | `2.0`                                  | Default chunk interval for streaming                          |
| **Audio**                          |                                        |                                                               |
| `VOICE_SAMPLE_RATE`                | `24000`                                | Internal generation sample rate (model native)                |
| `VOICE_OUTPUT_SAMPLE_RATE`         | `48000`                                | Output sample rate for clients                                |
| **Model Management**               |                                        |                                                               |
| `VOICE_IDLE_TIMEOUT`               | `1800`                                 | Seconds idle before auto-unloading models                     |
| `VOICE_CLEANUP_INTERVAL`           | `60`                                   | How often to check idle status                                |
| `VOICE_PRESET_MODEL`               | `Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` | Preset voice model slug                                       |
| `VOICE_CLONE_MODEL`                | `Qwen3-TTS-12Hz-1.7B-Base-8bit`        | Clone voice model slug                                        |
| **Queue**                          |                                        |                                                               |
| `VOICE_QUEUE_MAX_SIZE`             | `100`                                  | Max queued jobs (0 = unlimited)                               |
| `VOICE_QUEUE_RESULT_TTL`           | `3600`                                 | Seconds to keep completed jobs                                |
| `VOICE_QUEUE_WORKERS`              | `1`                                    | Concurrent workers (1 = sequential)                           |
| **Paths**                          |                                        |                                                               |
| `VOICE_MODELS_DIR`                 | `models`                               | Models directory (relative or absolute)                       |
| `VOICE_VOICES_DIR`                 | `voices`                               | Custom voices directory                                       |
| `VOICE_OUTPUTS_DIR`                | `outputs`                              | Saved outputs directory                                       |
| `VOICE_STATIC_DIR`                 | `static`                               | Web UI directory                                              |

### Default Fallback Behaviour

Every endpoint parameter has a three-level fallback chain:

```
Caller-provided value  →  .env setting  →  Hardcoded default
```

**Example:** If a caller sends `POST /v1/tts` with `{"text": "Hello"}` (no speaker), the server uses:

1. `VOICE_DEFAULT_SPEAKER` from `.env` (if set)
2. Hardcoded `"ryan"` (if `.env` has no value)

**Two default voices:** The system has separate defaults for each voice type:

- `VOICE_DEFAULT_SPEAKER` → used by preset endpoints (`/v1/tts`, `/v1/tts/stream`)
- `VOICE_DEFAULT_VOICE_NAME` → used by clone endpoints (`/v1/tts/clone`, `/v1/tts/clone/stream`, `WS /v1/tts/ws`)

This means you can configure a system-wide default voice/language/temperature once in `.env` and every caller inherits it without needing to specify it in every request.

---

## Response Headers

Audio-generating endpoints return these custom headers with every response:

| Header              | Type   | Description                                    |
| ------------------- | ------ | ---------------------------------------------- |
| `X-Audio-Duration`  | float  | Duration of generated audio in seconds         |
| `X-Generation-Time` | float  | Server-side generation time in seconds         |
| `X-Transcription`   | string | _(voice-to-voice only)_ Transcribed input text |
| `X-STT-Time`        | float  | _(voice-to-voice only)_ STT processing time    |
| `X-TTS-Time`        | float  | _(voice-to-voice only)_ TTS processing time    |
| `X-Total-Time`      | float  | _(voice-to-voice only)_ Total pipeline time    |

---

## Error Handling

All errors return JSON with an HTTP status code:

```json
{
  "detail": "Human-readable error message"
}
```

| Status | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| `400`  | Bad request (invalid speaker name, missing params, no speech detected) |
| `403`  | Invalid or missing API key                                             |
| `404`  | Custom voice or queue job not found                                    |
| `409`  | Conflict (e.g. trying to cancel a job already processing)              |
| `429`  | Queue full - too many jobs                                             |
| `500`  | Generation failed or internal server error                             |
| `503`  | Required model not downloaded                                          |

**Cold-start note:** If models are not loaded, the first request will take 10-15 seconds. This is **not** an error. Subsequent requests are fast. If you need to avoid this latency, call `/v1/warmup` first.

---

## Endpoints Reference

---

### Health & Status

#### `GET /health`

Lightweight health check. Does **not** load any models. Always accessible (no auth required).

**Response:**

```json
{
  "status": "ok",
  "mode": "lazy-load",
  "models_loaded": ["preset_tts", "clone_tts"],
  "idle_timeout_seconds": 1800,
  "sample_rate": 24000,
  "device": "apple_silicon_mlx"
}
```

---

#### `GET /v1/status`

Detailed system status including memory and idle timer.

**Response:**

```json
{
  "models_loaded": ["clone_tts"],
  "models_available": ["preset_tts", "clone_tts", "design_tts", "stt"],
  "idle_seconds": 142.3,
  "unload_in_seconds": 1657.7,
  "idle_timeout": 1800,
  "estimated_ram_gb": 3.0,
  "uptime_seconds": 3847.2
}
```

---

### Configuration & Defaults

#### `GET /v1/config`

Returns the active server configuration, including all defaults from `.env` or hardcoded fallbacks. Useful for client apps that want to display current settings or populate form defaults.

**Response:**

```json
{
  "defaults": {
    "speaker": "ryan",
    "voice_name": "Samantha",
    "language": "auto",
    "temperature": 0.7,
    "speed": 1.0,
    "max_tokens": 4096,
    "emotion": "friendly",
    "instruct": null,
    "resolved_instruct": "Speak in a warm, conversational, friendly manner",
    "streaming_interval": 2.0
  },
  "audio": {
    "internal_sample_rate": 24000,
    "output_sample_rate": 48000,
    "format": "WAV PCM 16-bit mono"
  },
  "models": {
    "preset": "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
    "clone": "Qwen3-TTS-12Hz-1.7B-Base-8bit",
    "design": null
  },
  "queue": {
    "max_size": 100,
    "result_ttl_seconds": 3600,
    "workers": 1
  },
  "idle_timeout_seconds": 1800,
  "auth_enabled": false,
  "streaming_enabled": true
}
```

---

### Model Lifecycle

#### `POST /v1/warmup`

Pre-load models before the first real request to avoid cold-start latency.

**Content-Type:** `multipart/form-data`

| Field    | Type   | Default | Description                                          |
| -------- | ------ | ------- | ---------------------------------------------------- |
| `models` | string | `"all"` | Which models: `all`, `tts`, `clone`, `design`, `stt` |

**Response:**

```json
{
  "loaded": ["preset_tts", "clone_tts", "stt"],
  "time_seconds": 14.2
}
```

---

#### `POST /v1/unload`

Immediately unload all models from RAM. Server stays running.

**No body required.**

**Response:**

```json
{
  "message": "All models unloaded from RAM",
  "freed_models": true
}
```

---

### Voices & Languages

#### `GET /v1/voices`

List all available voices (preset + custom).

**Response:**

```json
{
  "preset": ["ryan", "aiden", "vivian", "emma", "liam", "olivia", "noah", "ava", "sophia"],
  "custom": ["Samantha", "Matthew_Cage", "serena-clone"],
  "default": "ryan"
}
```

**Note:** This endpoint loads the preset model if not already loaded.

---

#### `GET /v1/languages`

List supported languages.

**Response:**

```json
{
  "languages": ["auto", "english", "chinese", "japanese", "korean", "french", "german", "spanish"],
  "default": "auto"
}
```

---

### Emotion / Style Presets

#### `GET /v1/emotions`

List all available emotion presets and how to use them.

**Response:**

```json
{
  "presets": {
    "neutral": "(no style applied)",
    "happy": "Speak with a warm, happy, upbeat tone",
    "sad": "Speak with a quiet, melancholic, sorrowful tone",
    "angry": "Speak with an intense, frustrated, angry tone",
    "excited": "Speak with high energy, enthusiasm, and excitement",
    "calm": "Speak with a gentle, soothing, relaxed pace",
    "whisper": "Speak in a soft whisper",
    "authoritative": "Speak with confidence and authority, like a news anchor",
    "friendly": "Speak in a warm, conversational, friendly manner",
    "serious": "Speak with a serious, measured, professional tone",
    "cheerful": "Speak with a bright, cheerful, sing-song quality",
    "empathetic": "Speak with genuine empathy and compassion",
    "narrative": "Speak like a calm audiobook narrator",
    "dramatic": "Speak with dramatic flair and theatrical emphasis",
    "sarcastic": "Speak with a dry, sarcastic edge"
  },
  "usage": "Pass 'emotion' key in any TTS endpoint (/v1/tts, /v1/tts/stream, /v1/tts/queue, WS /v1/tts/ws), or use 'instruct' for freeform text.",
  "examples": [
    { "emotion": "happy", "resolves_to": "Speak with a warm, happy, upbeat tone" },
    { "emotion": "whisper", "resolves_to": "Speak in a soft whisper" },
    {
      "instruct": "Like a pirate telling a bedtime story",
      "resolves_to": "Like a pirate telling a bedtime story"
    }
  ]
}
```

**Emotion vs Instruct:**

| Method                | How                                | Where                                                               |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| **Emotion preset**    | `"emotion": "happy"`               | `/v1/tts`, `/v1/tts/stream`, `/v1/tts/queue`, `WS /v1/tts/ws`       |
| **Freeform instruct** | `"instruct": "Like a pirate"`      | `/v1/tts`, `/v1/tts/stream`, `/v1/tts/queue`, `WS /v1/tts/ws`       |
| **Default emotion**   | `VOICE_DEFAULT_EMOTION` in `.env`  | Applied when caller omits both `emotion` and `instruct`             |
| **Default instruct**  | `VOICE_DEFAULT_INSTRUCT` in `.env` | Applied when caller omits both and `VOICE_DEFAULT_EMOTION` is empty |

**Priority order:** caller `emotion` > caller `instruct` > `.env` `VOICE_DEFAULT_EMOTION` > `.env` `VOICE_DEFAULT_INSTRUCT` > none

---

### Text-to-Speech - Preset Voices

#### `POST /v1/tts`

Generate speech using a built-in preset voice with optional emotion control.

**Content-Type:** `application/json`

**Request Body:**

```json
{
  "text": "Hello, this is a test of the voice synthesis system.",
  "speaker": "ryan",
  "language": "auto",
  "emotion": "friendly",
  "instruct": null,
  "speed": 1.0,
  "temperature": 0.7,
  "max_tokens": 4096
}
```

| Field         | Type   | Required | Default         | Constraints         | Description                                    |
| ------------- | ------ | -------- | --------------- | ------------------- | ---------------------------------------------- |
| `text`        | string | **yes**  | -               | max 5000 chars      | Text to speak                                  |
| `speaker`     | string | no       | `.env` → `ryan` | see `/v1/voices`    | Preset voice name                              |
| `language`    | string | no       | `.env` → `auto` | see `/v1/languages` | Language code                                  |
| `emotion`     | string | no       | `.env` → `null` | see `/v1/emotions`  | Emotion preset key (resolved to instruct text) |
| `instruct`    | string | no       | `.env` → `null` | -                   | Freeform emotion/style instruction             |
| `speed`       | float  | no       | `.env` → `1.0`  | 0.5 - 2.0           | Speech speed multiplier                        |
| `temperature` | float  | no       | `.env` → `0.7`  | 0.1 - 1.5           | Generation randomness                          |
| `max_tokens`  | int    | no       | `.env` → `4096` | 256 - 8192          | Max generation length                          |

**All non-required fields inherit from `.env` when omitted.** This means `{"text": "Hello"}` is a valid minimal request.

**Response:** `audio/wav` binary (PCM 16-bit, 48kHz, mono)

**Emotion examples:**

```bash
# Happy tone
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "This is wonderful news!", "instruct": "Speak with a warm, happy, upbeat tone"}'

# Whispered
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "I have a secret to tell you", "instruct": "Speak in a soft whisper"}'

# Custom style
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "The dragon soared over the mountains", "instruct": "Dramatic fantasy audiobook narrator"}'
```

---

#### `POST /v1/tts/stream`

Streaming version - returns audio chunks as they generate (lower time-to-first-audio).

**Content-Type:** `application/json`

**Request Body:** Same as `/v1/tts` (including `emotion` and `instruct`) plus:

| Field                | Type  | Default        | Constraints | Description            |
| -------------------- | ----- | -------------- | ----------- | ---------------------- |
| `streaming_interval` | float | `.env` → `2.0` | 0.5 - 10.0  | Seconds between chunks |

**Response:** `audio/wav` streaming binary. WAV header sent first, then PCM chunks.

> **Note:** When `VOICE_STREAMING_ENABLED=false` in `.env`, this endpoint returns `503 Service Unavailable`.

---

### WebSocket Streaming TTS

#### `WS /v1/tts/ws`

Real-time bidirectional WebSocket endpoint for TTS streaming. Supports both preset and cloned voices with binary PCM audio frames.

> **Note:** When `VOICE_STREAMING_ENABLED=false` in `.env`, the connection is closed immediately with code `1008`.

**Protocol:**

1. Client connects to `ws://localhost:8880/v1/tts/ws`
2. Client sends JSON configuration message
3. Server sends JSON metadata message
4. Server streams binary PCM16 LE audio frames (48kHz, mono)
5. Server sends JSON completion message
6. Client can close the connection at any time to cancel generation

**Configuration Message (Client → Server):**

```json
{
  "text": "Hello, world!",
  "speaker": "ryan",
  "language": "auto",
  "emotion": "happy",
  "instruct": null,
  "voice_name": null,
  "temperature": 0.7,
  "max_tokens": 4096,
  "streaming_interval": 2.0
}
```

| Field                | Type   | Required | Default        | Description                                 |
| -------------------- | ------ | -------- | -------------- | ------------------------------------------- |
| `text`               | string | **yes**  | -              | Text to synthesize                          |
| `speaker`            | string | no       | `.env` default | Preset voice name                           |
| `language`           | string | no       | `"auto"`       | Language code                               |
| `emotion`            | string | no       | -              | Emotion preset key                          |
| `instruct`           | string | no       | -              | Freeform style instruction                  |
| `voice_name`         | string | no       | -              | Custom/cloned voice name (uses clone model) |
| `temperature`        | float  | no       | `0.7`          | Generation randomness                       |
| `max_tokens`         | int    | no       | `4096`         | Max generation tokens                       |
| `streaming_interval` | float  | no       | `2.0`          | Seconds between audio chunks                |

**Metadata Message (Server → Client):**

```json
{
  "type": "metadata",
  "sample_rate": 48000,
  "channels": 1,
  "bit_depth": 16,
  "format": "pcm_s16le"
}
```

**Audio Frames (Server → Client):** Binary WebSocket messages containing raw PCM16 LE samples at 48kHz.

**Completion Message (Server → Client):**

```json
{
  "type": "done",
  "done": true,
  "duration": 3.2,
  "generation_time": 1.8,
  "total_samples": 153600,
  "sample_rate": 48000
}
```

**Error Message (Server → Client):**

```json
{
  "type": "error",
  "error": "Unknown speaker 'invalid'"
}
```

**Python Example (websockets):**

```python
import asyncio, json, wave, struct
import websockets

async def stream_tts():
    async with websockets.connect("ws://localhost:8880/v1/tts/ws") as ws:
        # Send config
        await ws.send(json.dumps({
            "text": "Hello from WebSocket streaming!",
            "speaker": "ryan",
            "emotion": "friendly"
        }))

        # Read metadata
        meta = json.loads(await ws.recv())
        sr = meta["sample_rate"]

        # Collect audio frames
        pcm_data = bytearray()
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                pcm_data.extend(msg)
            else:
                summary = json.loads(msg)
                if summary.get("type") == "done":
                    print(f"Done: {summary['duration']}s audio in {summary['generation_time']}s")
                    break
                elif summary.get("type") == "error":
                    print(f"Error: {summary['error']}")
                    break

        # Save to WAV
        with wave.open("ws_output.wav", "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(bytes(pcm_data))

asyncio.run(stream_tts())
```

**JavaScript Example (Browser):**

```javascript
const ws = new WebSocket("ws://localhost:8880/v1/tts/ws");
const audioCtx = new AudioContext({ sampleRate: 48000 });
let nextPlayTime = audioCtx.currentTime + 0.1;

ws.binaryType = "arraybuffer";

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      text: "Hello from WebSocket!",
      speaker: "ryan",
      emotion: "happy",
    }),
  );
};

ws.onmessage = (event) => {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data);
    if (msg.type === "done") console.log("Done:", msg);
    return;
  }

  // Binary PCM16 frame — schedule playback
  const pcm16 = new Int16Array(event.data);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

  const buffer = audioCtx.createBuffer(1, float32.length, 48000);
  buffer.copyToChannel(float32, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  if (nextPlayTime < audioCtx.currentTime) nextPlayTime = audioCtx.currentTime;
  source.start(nextPlayTime);
  nextPlayTime += float32.length / 48000;
};
```

---

### Text-to-Speech - Custom/Cloned Voices

> **Two formats available:** Each clone endpoint has a **form-data** version (original) and a **JSON** version (appended with `/json`). They produce identical results — choose whichever matches your caller's Content-Type.

#### `POST /v1/tts/clone` (form-data) &nbsp;|&nbsp; `POST /v1/tts/clone/json` (JSON)

Generate speech using a saved custom (cloned) voice.

**Form-data version** (`/v1/tts/clone`) — Content-Type: `multipart/form-data`

| Field         | Type   | Required | Default         | Description                                                                                |
| ------------- | ------ | -------- | --------------- | ------------------------------------------------------------------------------------------ |
| `text`        | string | **yes**  | -               | Text to speak                                                                              |
| `voice_name`  | string | no       | `.env` → `null` | Name of saved voice (e.g., `Samantha`). Required if `VOICE_DEFAULT_VOICE_NAME` is not set. |
| `language`    | string | no       | `"auto"`        | Language code                                                                              |
| `temperature` | float  | no       | `0.7`           | Generation randomness (0.1 - 1.5)                                                          |

**JSON version** (`/v1/tts/clone/json`) — Content-Type: `application/json`

| Field         | Type   | Required | Default         | Description                                                                                |
| ------------- | ------ | -------- | --------------- | ------------------------------------------------------------------------------------------ |
| `text`        | string | **yes**  | -               | Text to speak                                                                              |
| `voice_name`  | string | no       | `.env` → `null` | Name of saved voice (e.g., `Samantha`). Required if `VOICE_DEFAULT_VOICE_NAME` is not set. |
| `language`    | string | no       | `"auto"`        | Language code                                                                              |
| `temperature` | float  | no       | `0.7`           | Generation randomness (0.1 - 1.5)                                                          |

**Response:** `audio/wav` binary (PCM 16-bit, 48kHz, mono)

**Examples:**

```bash
# JSON (recommended for programmatic callers / AI agents)
curl -X POST http://localhost:8880/v1/tts/clone/json \
  -H "Content-Type: application/json" \
  -d '{"text": "This is Samantha speaking through the API.", "voice_name": "Samantha"}' \
  --output samantha_output.wav

# Form-data (used by web UI and multipart callers)
curl -X POST http://localhost:8880/v1/tts/clone \
  -F "voice_name=Samantha" \
  -F "text=This is Samantha speaking through the API." \
  --output samantha_output.wav
```

**Python examples:**

```python
import requests

# JSON version — use json= parameter
response = requests.post("http://localhost:8880/v1/tts/clone/json", json={
    "text": "Hello from Samantha!",
    "voice_name": "Samantha",
})

# Form-data version — use data= parameter (NOT json=)
response = requests.post("http://localhost:8880/v1/tts/clone", data={
    "text": "Hello from Samantha!",
    "voice_name": "Samantha",
})
```

---

#### `POST /v1/tts/clone/stream` (form-data) &nbsp;|&nbsp; `POST /v1/tts/clone/stream/json` (JSON)

Streaming version of clone TTS - returns audio chunks as they generate.

**Form-data version** (`/v1/tts/clone/stream`) — Content-Type: `multipart/form-data`

| Field                | Type   | Required | Default         | Description                                                             |
| -------------------- | ------ | -------- | --------------- | ----------------------------------------------------------------------- |
| `text`               | string | **yes**  | -               | Text to speak                                                           |
| `voice_name`         | string | no       | `.env` → `null` | Name of saved voice. Required if `VOICE_DEFAULT_VOICE_NAME` is not set. |
| `language`           | string | no       | `"auto"`        | Language code                                                           |
| `temperature`        | float  | no       | `0.7`           | Generation randomness                                                   |
| `streaming_interval` | float  | no       | `2.0`           | Seconds between chunks (0.5 - 10.0)                                     |

**JSON version** (`/v1/tts/clone/stream/json`) — Content-Type: `application/json`

| Field                | Type   | Required | Default         | Description                                                             |
| -------------------- | ------ | -------- | --------------- | ----------------------------------------------------------------------- |
| `text`               | string | **yes**  | -               | Text to speak                                                           |
| `voice_name`         | string | no       | `.env` → `null` | Name of saved voice. Required if `VOICE_DEFAULT_VOICE_NAME` is not set. |
| `language`           | string | no       | `"auto"`        | Language code                                                           |
| `temperature`        | float  | no       | `0.7`           | Generation randomness                                                   |
| `streaming_interval` | float  | no       | `2.0`           | Seconds between chunks (0.5 - 10.0)                                     |

**Response:** `audio/wav` streaming binary. WAV header sent first, then PCM chunks.

> **Note:** When `VOICE_STREAMING_ENABLED=false` in `.env`, this endpoint returns `503 Service Unavailable`.

**Examples:**

```bash
# JSON
curl -X POST http://localhost:8880/v1/tts/clone/stream/json \
  -H "Content-Type: application/json" \
  -d '{"text": "This is a streaming clone test.", "voice_name": "Samantha", "streaming_interval": 1.5}' \
  --output samantha_streamed.wav

# Form-data
curl -X POST http://localhost:8880/v1/tts/clone/stream \
  -F "voice_name=Samantha" \
  -F "text=This is a streaming clone test." \
  -F "streaming_interval=1.5" \
  --output samantha_streamed.wav
```

**JavaScript Streaming Playback Example:**

```javascript
async function streamCloneAudio(voiceName, text) {
  const form = new FormData();
  form.append("voice_name", voiceName);
  form.append("text", text);

  const response = await fetch("/v1/tts/clone/stream", { method: "POST", body: form });
  const reader = response.body.getReader();
  const audioCtx = new AudioContext({ sampleRate: 48000 });
  let nextPlayTime = audioCtx.currentTime + 0.1;
  let headerSkipped = false;
  let leftover = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    let data = leftover.length > 0 ? new Uint8Array([...leftover, ...value]) : value;
    leftover = new Uint8Array(0);

    // Skip 44-byte WAV header
    if (!headerSkipped) {
      if (data.length < 44) {
        leftover = data;
        continue;
      }
      headerSkipped = true;
      data = data.slice(44);
      if (data.length === 0) continue;
    }

    // Ensure even byte count for PCM16
    if (data.length % 2 !== 0) {
      leftover = data.slice(-1);
      data = data.slice(0, -1);
    }
    if (data.length === 0) continue;

    // Convert PCM16 LE → Float32 and schedule playback
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    const float32 = new Float32Array(data.length / 2);
    for (let i = 0; i < float32.length; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = audioCtx.createBuffer(1, float32.length, 48000);
    buffer.copyToChannel(float32, 0);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    if (nextPlayTime < audioCtx.currentTime) nextPlayTime = audioCtx.currentTime;
    source.start(nextPlayTime);
    nextPlayTime += float32.length / 48000;
  }
}
```

---

### TTS Queue

The queue system lets you submit TTS jobs that process in the background. This is ideal for:

- **Batch processing** multiple texts
- **Non-blocking calls** from apps that don't want to wait
- **Priority ordering** of jobs
- **Webhook callbacks** when jobs complete
- **Auto-saving** outputs to disk

#### `POST /v1/tts/queue`

Submit a TTS job to the background queue. Returns immediately with a job ID.

**Content-Type:** `application/json`

**Request Body:**

```json
{
  "text": "Hello, this is a queued TTS job.",
  "speaker": "ryan",
  "language": "auto",
  "emotion": "happy",
  "instruct": null,
  "speed": 1.0,
  "temperature": 0.7,
  "max_tokens": 4096,
  "voice_name": null,
  "save_output": false,
  "callback_url": null,
  "priority": 5
}
```

| Field          | Type   | Required | Default        | Description                             |
| -------------- | ------ | -------- | -------------- | --------------------------------------- |
| `text`         | string | **yes**  | -              | Text to speak (max 5000 chars)          |
| `speaker`      | string | no       | `.env` default | Preset voice name                       |
| `language`     | string | no       | `.env` default | Language code                           |
| `emotion`      | string | no       | `null`         | Emotion preset key (see `/v1/emotions`) |
| `instruct`     | string | no       | `.env` default | Freeform style instruction              |
| `speed`        | float  | no       | `.env` default | Speech speed (0.5-2.0)                  |
| `temperature`  | float  | no       | `.env` default | Randomness (0.1-1.5)                    |
| `max_tokens`   | int    | no       | `.env` default | Max tokens (256-8192)                   |
| `voice_name`   | string | no       | `null`         | Custom voice name (uses clone model)    |
| `save_output`  | bool   | no       | `false`        | Save WAV to `outputs/` directory        |
| `callback_url` | string | no       | `null`         | POST job result JSON here when done     |
| `priority`     | int    | no       | `5`            | 1 (highest) to 10 (lowest)              |

**`emotion` vs `instruct`:** If both are set, `emotion` takes precedence. The emotion key is looked up in the preset table and resolved to its instruct string.

**Response:**

```json
{
  "id": "a1b2c3d4",
  "status": "queued",
  "message": "Job submitted successfully",
  "poll_url": "/v1/tts/queue/a1b2c3d4",
  "audio_url": "/v1/tts/queue/a1b2c3d4/audio"
}
```

---

#### `GET /v1/tts/queue`

List all queue jobs with optional status filter.

**Query Parameters:**

| Param    | Type   | Default | Description                                                        |
| -------- | ------ | ------- | ------------------------------------------------------------------ |
| `status` | string | _(all)_ | Filter: `queued`, `processing`, `completed`, `failed`, `cancelled` |
| `limit`  | int    | `50`    | Max results                                                        |

**Response:**

```json
{
  "jobs": [
    {
      "id": "a1b2c3d4",
      "status": "completed",
      "created_at": "2026-02-17T15:30:00",
      "started_at": "2026-02-17T15:30:01",
      "completed_at": "2026-02-17T15:30:04",
      "audio_duration": 5.4,
      "generation_time": 2.9,
      "error": null,
      "output_path": "queue_a1b2c3d4.wav",
      "text_preview": "Hello, this is a queued TTS job.",
      "speaker": "ryan",
      "has_audio": true
    }
  ],
  "total": 12,
  "counts": {
    "queued": 2,
    "processing": 1,
    "completed": 8,
    "failed": 1
  }
}
```

---

#### `GET /v1/tts/queue/{job_id}`

Check status of a specific job.

**Response (queued):**

```json
{
  "id": "a1b2c3d4",
  "status": "queued",
  "queue_position": 3,
  "text_preview": "Hello...",
  "speaker": "ryan"
}
```

**Response (completed):**

```json
{
  "id": "a1b2c3d4",
  "status": "completed",
  "audio_duration": 5.4,
  "generation_time": 2.9,
  "has_audio": true
}
```

---

#### `GET /v1/tts/queue/{job_id}/audio`

Download the audio result of a completed job.

**Response:** `audio/wav` binary with `Content-Disposition: attachment` header.

Returns `400` if job is not yet completed.

---

#### `DELETE /v1/tts/queue/{job_id}`

Cancel a queued job (only works for jobs still in `queued` state).

**Response:**

```json
{
  "id": "a1b2c3d4",
  "status": "cancelled",
  "message": "Job cancelled"
}
```

---

#### Queue Workflow Example

```python
import requests, time

BASE = "http://localhost:8880"

# 1. Submit multiple jobs
jobs = []
for text in ["First paragraph.", "Second paragraph.", "Third paragraph."]:
    r = requests.post(f"{BASE}/v1/tts/queue", json={
        "text": text,
        "emotion": "narrative",
        "voice_name": "Samantha",
        "save_output": True,
    })
    jobs.append(r.json()["id"])

# 2. Poll until all complete
while True:
    statuses = []
    for jid in jobs:
        r = requests.get(f"{BASE}/v1/tts/queue/{jid}")
        statuses.append(r.json()["status"])
    if all(s in ("completed", "failed") for s in statuses):
        break
    time.sleep(2)

# 3. Download results
for jid in jobs:
    r = requests.get(f"{BASE}/v1/tts/queue/{jid}/audio")
    with open(f"{jid}.wav", "wb") as f:
        f.write(r.content)
```

---

### Speech-to-Text

#### `POST /v1/stt`

Transcribe audio to text using Whisper (distil-large-v3).

**Content-Type:** `multipart/form-data`

| Field      | Type   | Required | Default | Description                        |
| ---------- | ------ | -------- | ------- | ---------------------------------- |
| `file`     | file   | **yes**  | -       | Audio file (WAV, MP3, M4A, etc.)   |
| `language` | string | no       | `null`  | Language hint (null = auto-detect) |

**Response:**

```json
{
  "text": "Hello, this is a transcription test.",
  "language": "en",
  "processing_time": 1.234
}
```

---

### Voice-to-Voice

#### `POST /v1/voice-to-voice`

Full pipeline: upload audio, transcribe it, then re-synthesize with a different voice.

**Content-Type:** `multipart/form-data`

| Field        | Type   | Required | Default        | Description                              |
| ------------ | ------ | -------- | -------------- | ---------------------------------------- |
| `file`       | file   | **yes**  | -              | Input audio file                         |
| `speaker`    | string | no       | `.env` default | Voice name (preset or custom)            |
| `language`   | string | no       | `"auto"`       | Language code                            |
| `instruct`   | string | no       | `null`         | Emotion instruction (preset voices only) |
| `use_custom` | bool   | no       | `false`        | Set `true` to use a custom/cloned voice  |

**Response:** `audio/wav` binary with pipeline timing headers.

---

### Custom Voice Management

#### `GET /v1/custom-voices`

List all saved custom voices with metadata.

**Response:**

```json
{
  "voices": [
    {
      "name": "Samantha",
      "transcript": "Well, right when you asked me if I had a name...",
      "created": "2026-02-17T14:46:48.985055",
      "language": "auto"
    }
  ]
}
```

---

#### `POST /v1/custom-voices`

Create a new custom voice from a reference audio clip.

**Content-Type:** `multipart/form-data`

| Field        | Type   | Required | Description                              |
| ------------ | ------ | -------- | ---------------------------------------- |
| `name`       | string | **yes**  | Voice name (alphanumeric, max 50 chars)  |
| `transcript` | string | **yes**  | Exact transcript of the audio clip       |
| `language`   | string | no       | Language code (default: `auto`)          |
| `file`       | file   | **yes**  | Reference audio (WAV recommended, 5-10s) |

---

#### `DELETE /v1/custom-voices/{name}`

Delete a custom voice permanently.

---

#### `POST /v1/custom-voices/{name}/preview`

Generate a preview with a custom voice.

| Field      | Type   | Default                         | Description  |
| ---------- | ------ | ------------------------------- | ------------ |
| `text`     | string | `"Hello, this is a preview..."` | Preview text |
| `language` | string | `"auto"`                        | Language     |

**Response:** `audio/wav` binary

---

#### `GET /v1/custom-voices/{name}/audio`

Download the reference audio clip of a custom voice.

---

### Outputs

#### `GET /v1/outputs`

List recently saved output files (last 50).

---

## Integration Patterns

### Python

```python
import requests

BASE_URL = "http://localhost:8880"

# --- Check current defaults ---
def get_defaults():
    r = requests.get(f"{BASE_URL}/v1/config")
    return r.json()["defaults"]

# --- List available voices ---
def list_voices():
    r = requests.get(f"{BASE_URL}/v1/voices")
    data = r.json()
    print(f"Preset: {data['preset']}")
    print(f"Custom: {data['custom']}")
    print(f"Default: {data['default']}")
    return data

# --- List emotion presets ---
def list_emotions():
    r = requests.get(f"{BASE_URL}/v1/emotions")
    return r.json()["presets"]

# --- Generate with emotion (uses .env defaults for speaker, temp, etc.) ---
def speak_with_emotion(text: str, emotion_instruct: str = None):
    payload = {"text": text}
    if emotion_instruct:
        payload["instruct"] = emotion_instruct
    response = requests.post(f"{BASE_URL}/v1/tts", json=payload)
    response.raise_for_status()
    return response.content  # WAV bytes

# --- Generate with custom voice ---
def speak_as_samantha(text: str, output_path: str = "output.wav"):
    response = requests.post(f"{BASE_URL}/v1/tts/clone", data={
        "voice_name": "Samantha",
        "text": text,
    })
    response.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(response.content)
    return output_path

# --- Queue batch processing ---
def queue_batch(texts: list, voice_name: str = None, emotion: str = None):
    """Submit multiple texts and return job IDs."""
    job_ids = []
    for text in texts:
        payload = {"text": text, "save_output": True}
        if voice_name:
            payload["voice_name"] = voice_name
        if emotion:
            payload["emotion"] = emotion
        r = requests.post(f"{BASE_URL}/v1/tts/queue", json=payload)
        r.raise_for_status()
        job_ids.append(r.json()["id"])
    return job_ids

def poll_jobs(job_ids: list, interval: float = 2.0):
    """Wait for all jobs to finish."""
    import time
    while True:
        done = True
        for jid in job_ids:
            r = requests.get(f"{BASE_URL}/v1/tts/queue/{jid}")
            if r.json()["status"] not in ("completed", "failed", "cancelled"):
                done = False
                break
        if done:
            return
        time.sleep(interval)

def download_job_audio(job_id: str, output_path: str):
    r = requests.get(f"{BASE_URL}/v1/tts/queue/{job_id}/audio")
    r.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(r.content)

# Usage
if __name__ == "__main__":
    # Check what's available
    list_voices()
    list_emotions()

    # Simple TTS (inherits all defaults from .env)
    wav = speak_with_emotion("Hello world!")

    # TTS with emotion
    wav = speak_with_emotion("This is amazing news!", "Speak with excitement")

    # Batch queue with Samantha voice
    ids = queue_batch(
        ["Chapter 1: The beginning.", "Chapter 2: The journey."],
        voice_name="Samantha",
        emotion="narrative"
    )
    poll_jobs(ids)
    for i, jid in enumerate(ids):
        download_job_audio(jid, f"chapter_{i+1}.wav")
```

---

### JavaScript / TypeScript

```typescript
const BASE_URL = "http://localhost:8880";

/** Get current server defaults */
async function getConfig() {
  const r = await fetch(`${BASE_URL}/v1/config`);
  return r.json();
}

/** List all voices (preset + custom) */
async function listVoices() {
  const r = await fetch(`${BASE_URL}/v1/voices`);
  return r.json(); // { preset: [...], custom: [...], default: "ryan" }
}

/** List emotion presets */
async function listEmotions() {
  const r = await fetch(`${BASE_URL}/v1/emotions`);
  return r.json(); // { presets: { happy: "...", ... } }
}

/** Generate speech - minimal call (inherits .env defaults) */
async function speak(
  text: string,
  options?: {
    speaker?: string;
    instruct?: string;
    temperature?: number;
  },
): Promise<Blob> {
  const body: Record<string, any> = { text, ...options };
  const r = await fetch(`${BASE_URL}/v1/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail);
  return r.blob();
}

/** Submit a queue job */
async function queueTTS(
  text: string,
  options?: {
    emotion?: string;
    voice_name?: string;
    save_output?: boolean;
    callback_url?: string;
  },
) {
  const r = await fetch(`${BASE_URL}/v1/tts/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...options }),
  });
  return r.json(); // { id, status, poll_url, audio_url }
}

/** Poll a queue job until done */
async function waitForJob(jobId: string, interval = 2000): Promise<any> {
  while (true) {
    const r = await fetch(`${BASE_URL}/v1/tts/queue/${jobId}`);
    const data = await r.json();
    if (["completed", "failed", "cancelled"].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Download queue job audio */
async function downloadJobAudio(jobId: string): Promise<Blob> {
  const r = await fetch(`${BASE_URL}/v1/tts/queue/${jobId}/audio`);
  if (!r.ok) throw new Error("Audio not ready");
  return r.blob();
}
```

---

### Swift (iOS / macOS)

```swift
import Foundation
import AVFoundation

class VoiceStudioClient {
    let baseURL: String
    private var audioPlayer: AVAudioPlayer?

    init(baseURL: String = "http://localhost:8880") {
        self.baseURL = baseURL
    }

    /// Get available voices
    func listVoices(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let url = URL(string: "\(baseURL)/v1/voices")!
        URLSession.shared.dataTask(with: url) { data, _, error in
            if let error = error { completion(.failure(error)); return }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { completion(.failure(NSError(domain: "", code: -1))); return }
            completion(.success(json))
        }.resume()
    }

    /// Get emotion presets
    func listEmotions(completion: @escaping (Result<[String: String], Error>) -> Void) {
        let url = URL(string: "\(baseURL)/v1/emotions")!
        URLSession.shared.dataTask(with: url) { data, _, error in
            if let error = error { completion(.failure(error)); return }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let presets = json["presets"] as? [String: String]
            else { completion(.failure(NSError(domain: "", code: -1))); return }
            completion(.success(presets))
        }.resume()
    }

    /// Generate speech (minimal - inherits server defaults)
    func speak(text: String, completion: @escaping (Result<Data, Error>) -> Void) {
        let url = URL(string: "\(baseURL)/v1/tts")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let data = data,
                  (response as? HTTPURLResponse)?.statusCode == 200
            else { completion(.failure(NSError(domain: "", code: -1))); return }
            completion(.success(data))
        }.resume()
    }

    /// Queue a TTS job
    func queueTTS(text: String, emotion: String? = nil, voiceName: String? = nil,
                  completion: @escaping (Result<String, Error>) -> Void) {
        let url = URL(string: "\(baseURL)/v1/tts/queue")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["text": text, "save_output": true]
        if let e = emotion { body["emotion"] = e }
        if let v = voiceName { body["voice_name"] = v }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { data, _, error in
            if let error = error { completion(.failure(error)); return }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let jobId = json["id"] as? String
            else { completion(.failure(NSError(domain: "", code: -1))); return }
            completion(.success(jobId))
        }.resume()
    }
}
```

---

### cURL

```bash
# ===== Discovery =====

# Health check (fast, no model loading)
curl http://localhost:8880/health

# Current configuration & defaults
curl http://localhost:8880/v1/config

# List all voices
curl http://localhost:8880/v1/voices

# List emotion presets
curl http://localhost:8880/v1/emotions

# List languages
curl http://localhost:8880/v1/languages

# Detailed status (models loaded, RAM, idle time)
curl http://localhost:8880/v1/status


# ===== Text-to-Speech =====

# Minimal TTS (uses all .env defaults)
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world!"}' \
  --output hello.wav

# TTS with specific voice and emotion
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "This is amazing!", "speaker": "vivian", "instruct": "Very excited and happy"}' \
  --output excited.wav

# TTS with custom/cloned voice — JSON (recommended for programmatic callers)
curl -X POST http://localhost:8880/v1/tts/clone/json \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from Samantha!", "voice_name": "Samantha"}' \
  --output samantha.wav

# TTS with custom/cloned voice — form-data (used by web UI)
curl -X POST http://localhost:8880/v1/tts/clone \
  -F "voice_name=Samantha" \
  -F "text=Hello from Samantha!" \
  --output samantha.wav

# Streaming TTS (preset voice)
curl -X POST http://localhost:8880/v1/tts/stream \
  -H "Content-Type: application/json" \
  -d '{"text": "Long text...", "streaming_interval": 2.0}' \
  --output streamed.wav

# Streaming TTS (cloned voice) — JSON
curl -X POST http://localhost:8880/v1/tts/clone/stream/json \
  -H "Content-Type: application/json" \
  -d '{"text": "This is a streaming clone test.", "voice_name": "Samantha", "streaming_interval": 1.5}' \
  --output samantha_streamed.wav

# Streaming TTS (cloned voice) — form-data
curl -X POST http://localhost:8880/v1/tts/clone/stream \
  -F "voice_name=Samantha" \
  -F "text=This is a streaming clone test." \
  -F "streaming_interval=1.5" \
  --output samantha_streamed.wav

# WebSocket TTS (requires wscat or similar)
# npm install -g wscat
# wscat -c ws://localhost:8880/v1/tts/ws
# > {"text": "Hello via WebSocket!", "speaker": "ryan", "emotion": "happy"}
# (binary PCM frames + final JSON summary)


# ===== Queue (Batch / Async) =====

# Submit a job with emotion
curl -X POST http://localhost:8880/v1/tts/queue \
  -H "Content-Type: application/json" \
  -d '{"text": "Queued job!", "emotion": "happy", "save_output": true}'

# Submit a job with custom voice
curl -X POST http://localhost:8880/v1/tts/queue \
  -H "Content-Type: application/json" \
  -d '{"text": "Queue with Samantha", "voice_name": "Samantha", "save_output": true}'

# List all jobs
curl http://localhost:8880/v1/tts/queue

# List only completed jobs
curl "http://localhost:8880/v1/tts/queue?status=completed"

# Check specific job status
curl http://localhost:8880/v1/tts/queue/abc12345

# Download completed job audio
curl http://localhost:8880/v1/tts/queue/abc12345/audio --output result.wav

# Cancel a queued job
curl -X DELETE http://localhost:8880/v1/tts/queue/abc12345


# ===== STT & Voice-to-Voice =====

# Transcribe audio
curl -X POST http://localhost:8880/v1/stt -F "file=@recording.wav"

# Voice-to-voice with Samantha
curl -X POST http://localhost:8880/v1/voice-to-voice \
  -F "file=@input.wav" \
  -F "speaker=Samantha" \
  -F "use_custom=true" \
  --output converted.wav


# ===== Custom Voice Management =====

# List custom voices
curl http://localhost:8880/v1/custom-voices

# Create a new custom voice
curl -X POST http://localhost:8880/v1/custom-voices \
  -F "name=My_Voice" \
  -F "transcript=The exact words spoken in the clip." \
  -F "file=@reference.wav"

# Preview a custom voice
curl -X POST http://localhost:8880/v1/custom-voices/My_Voice/preview \
  -F "text=Testing my new voice" \
  --output preview.wav

# Delete a custom voice
curl -X DELETE http://localhost:8880/v1/custom-voices/My_Voice


# ===== Model Management =====

# Pre-load models (avoid cold start)
curl -X POST http://localhost:8880/v1/warmup -F "models=all"

# Unload all models from RAM
curl -X POST http://localhost:8880/v1/unload
```

---

## Deployed / Remote Access

The server binds to `0.0.0.0:8880` by default, so it's accessible from other devices on the same network.

### Local Network Access

```bash
# Find your Mac's IP
ipconfig getifaddr en0

# Access from another device
curl http://192.168.1.XXX:8880/health
```

### SSH Tunnel (Secure Remote Access)

```bash
ssh -L 8880:localhost:8880 user@your-mac-ip
```

### Reverse Proxy with ngrok

```bash
ngrok http 8880
```

### Production Considerations

1. **Install as service:** `./service.sh install`
2. **Set idle timeout:** `VOICE_IDLE_TIMEOUT=3600` in `.env`
3. **Enable API key:** `VOICE_API_KEY=your-secret-key` in `.env`
4. **Add HTTPS** via nginx/Caddy reverse proxy

---

## Service Management

### `service.sh` Commands

```bash
./service.sh install      # Install as macOS login agent (auto-starts)
./service.sh uninstall    # Remove service
./service.sh start        # Start server
./service.sh stop         # Stop server
./service.sh restart      # Restart server
./service.sh status       # Show status, models, RAM
./service.sh logs         # Tail logs
./service.sh unload       # Unload models from RAM
```

### OpenAPI / Swagger Docs

FastAPI auto-generates interactive API docs:

- **Swagger UI:** [http://localhost:8880/docs](http://localhost:8880/docs)
- **ReDoc:** [http://localhost:8880/redoc](http://localhost:8880/redoc)

---

## Model Management

The model management system lets you browse, download, activate, and delete Qwen3-TTS MLX model variants through the API and UI.

### Key Concepts

- **Model Catalog**: 25 MLX-format Qwen3-TTS models are known (combinations of 0.6B/1.7B × Base/CustomVoice/VoiceDesign × 4bit/5bit/6bit/8bit/bf16)
- **Roles**: Each model fills a role based on its `tts_model_type`:
  - `clone` — Base models (voice cloning via `generate()`)
  - `preset` — CustomVoice models (preset speakers via `generate_custom_voice()`)
  - `design` — VoiceDesign models (voice from text description via `generate_voice_design()`)
- **Hot-Swap**: Activating a new model for a role unloads the previous one; the new model loads lazily on next request
- **Downloads**: Models download from HuggingFace (`mlx-community/*`) into the `models/` directory

---

### `GET /v1/models`

List all models from the catalog with their download/loaded/active status.

**Response:**

```json
{
  "models": [
    {
      "slug": "Qwen3-TTS-12Hz-1.7B-Base-8bit",
      "hf_repo": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
      "family": "1.7B",
      "variant": "Base",
      "quant": "8bit",
      "role": "clone",
      "tts_model_type": "base",
      "tts_model_size": "1b7",
      "size_gb": 2.3,
      "description": "1.7B Voice cloning + predefined speakers (8bit)",
      "backend": "mlx",
      "generation_method": "generate()",
      "supports_instruct": true,
      "downloaded": true,
      "active_for": ["clone"],
      "loaded": false
    }
  ],
  "total": 25,
  "downloaded": 2
}
```

---

### `GET /v1/models/active`

Show which models are currently active for each role.

**Response:**

```json
{
  "preset": { "slug": "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "loaded": true, "info": { ... } },
  "clone": { "slug": "Qwen3-TTS-12Hz-1.7B-Base-8bit", "loaded": false, "info": { ... } },
  "design": { "slug": null, "loaded": false, "info": null }
}
```

---

### `GET /v1/models/{slug}`

Get detailed info for a specific model, including disk size if downloaded.

**Response:** Same shape as an item in `GET /v1/models`, plus `disk_size_bytes` and `disk_size_gb` when downloaded.

---

### `POST /v1/models/{slug}/download`

Start downloading a model from HuggingFace. Only one download runs at a time; additional requests are queued.

**Response:**

```json
{
  "slug": "Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
  "status": "downloading",
  "message": "Download started",
  "poll_url": "/v1/models/downloads"
}
```

**Error Codes:**

- `404` — Unknown model slug
- `507` — Insufficient disk space

---

### `DELETE /v1/models/{slug}/download`

Cancel an in-progress or queued download.

**Response:**

```json
{ "slug": "...", "status": "cancelled", "message": "Download cancellation requested" }
```

---

### `GET /v1/models/downloads`

List all active/recent download tasks with progress.

**Response:**

```json
{
  "downloads": [
    {
      "slug": "Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
      "status": "downloading",
      "progress_pct": 45.2,
      "downloaded_bytes": 1073741824,
      "total_bytes": 2469606195,
      "speed_mbps": 42.5,
      "eta_seconds": 31,
      "error": null,
      "started_at": 1739812345.0,
      "completed_at": null
    }
  ],
  "active": "Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
  "queued": []
}
```

---

### `POST /v1/models/{slug}/activate`

Activate a downloaded model for a specific role. The server validates that the model's `tts_model_type` matches the requested role.

**Request Body (JSON):**

```json
{ "role": "preset" }
```

| Field  | Type   | Required | Values                               |
| ------ | ------ | -------- | ------------------------------------ |
| `role` | string | yes      | `"preset"`, `"clone"`, or `"design"` |

**Role Validation:**

- Base models → only `"clone"`
- CustomVoice models → only `"preset"`
- VoiceDesign models → only `"design"`

**Response:**

```json
{
  "slug": "Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit",
  "role": "preset",
  "message": "Model 'Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit' activated as preset",
  "previous": "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
}
```

**Error Codes:**

- `400` — Model not downloaded, or role/variant mismatch
- `404` — Unknown model slug

---

### `DELETE /v1/models/{slug}`

Delete a downloaded model from disk. Cannot delete active models.

**Response:**

```json
{ "slug": "...", "message": "Model '...' deleted from disk" }
```

**Error Codes:**

- `400` — Model is currently active (activate a different model first)
- `404` — Model not found on disk or unknown slug

---

## Performance Notes

### Latency Expectations (Apple Silicon M4)

| Operation                  | Cold Start | Warm (model loaded) |
| -------------------------- | ---------- | ------------------- |
| Health check               | instant    | instant             |
| Config / voices / emotions | instant    | instant             |
| Preset TTS (1 sentence)    | ~12s       | ~2-4s               |
| Clone TTS (1 sentence)     | ~15s       | ~3-6s               |
| STT transcribe (10s audio) | ~8s        | ~1-2s               |
| Voice-to-voice             | ~20s       | ~4-8s               |
| Queue submit               | instant    | instant             |

### RAM Usage

| State                   | Approximate RAM |
| ----------------------- | --------------- |
| Server idle (no models) | ~30-50 MB       |
| + Preset TTS model      | +3 GB           |
| + Clone TTS model       | +3 GB           |
| + VoiceDesign TTS model | +3 GB           |
| + STT model             | +0.5 GB         |
| All models loaded       | ~9.5 GB total   |

### Best Practices

1. **Use `/v1/config`** to verify active defaults before building a client
2. **Use `/v1/emotions`** to get the latest emotion preset list
3. **Use `/health` for monitoring** - it never loads models
4. **Use queue for batch work** - submit all jobs, then poll/download
5. **Set `.env` defaults** to match your most common use case
6. **Call `/v1/warmup`** at app startup if you need predictable latency
7. **Set `VOICE_IDLE_TIMEOUT`** based on usage:
   - Frequent use: `3600` (1 hour)
   - Occasional: `1800` (30 min, default)
   - RAM-constrained: `600` (10 min)

---

---

## Common Mistakes & Troubleshooting

This section documents the most frequent integration errors, especially from AI agent callers.

### Wrong HTTP method for TTS

| Mistake                         | Error                    | Fix                                               |
| ------------------------------- | ------------------------ | ------------------------------------------------- |
| `GET /v1/tts`                   | `405 Method Not Allowed` | Use `POST /v1/tts` with JSON body                 |
| `GET /v1/tts/stream`            | `405 Method Not Allowed` | Use `POST /v1/tts/stream` with JSON body          |
| `GET /v1/tts/clone`             | `405 Method Not Allowed` | Use `POST /v1/tts/clone` with form-data           |
| `GET /v1/tts/queue` (to submit) | Gets queue list instead  | Use `POST /v1/tts/queue` with JSON body to submit |

**Rule:** All TTS _generation_ endpoints require `POST`. `GET` is only for discovery and status endpoints.

### Non-existent endpoint `/v1/speakers`

There is **no** `/v1/speakers` endpoint. The correct endpoint to list available voices is:

```bash
GET /v1/voices
```

Response:

```json
{
  "preset": ["ryan", "aiden", "vivian", ...],
  "custom": ["Samantha2", ...],
  "default": "ryan"
}
```

### Wrong Content-Type for preset vs clone endpoints

> **Tip:** If you're a programmatic caller or AI agent that prefers JSON for everything, use the `/json` variants of clone endpoints: `/v1/tts/clone/json` and `/v1/tts/clone/stream/json`. These accept `application/json` just like the preset TTS endpoints.

| Endpoint                         | Expected Content-Type | Common Mistake                                             |
| -------------------------------- | --------------------- | ---------------------------------------------------------- |
| `POST /v1/tts`                   | `application/json`    | Sending form-data                                          |
| `POST /v1/tts/stream`            | `application/json`    | Sending form-data                                          |
| `POST /v1/tts/clone`             | `multipart/form-data` | Sending JSON → **use `/v1/tts/clone/json` instead**        |
| `POST /v1/tts/clone/json`        | `application/json`    | _(new)_ JSON alternative to `/v1/tts/clone`                |
| `POST /v1/tts/clone/stream`      | `multipart/form-data` | Sending JSON → **use `/v1/tts/clone/stream/json` instead** |
| `POST /v1/tts/clone/stream/json` | `application/json`    | _(new)_ JSON alternative to `/v1/tts/clone/stream`         |
| `POST /v1/tts/queue`             | `application/json`    | Sending form-data                                          |

### Using a custom voice name as a preset speaker

Custom voices (e.g., `Samantha2`) are **not** valid `speaker` values. They must be used via the clone endpoints:

```bash
# WRONG — will fail with "Speaker 'Samantha2' not supported"
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "speaker": "Samantha2"}'

# CORRECT — use the JSON clone endpoint with voice_name
curl -X POST http://localhost:8880/v1/tts/clone/json \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "voice_name": "Samantha2"}'

# ALSO CORRECT — form-data clone endpoint
curl -X POST http://localhost:8880/v1/tts/clone \
  -F "text=Hello" \
  -F "voice_name=Samantha2"
```

To see which voices are preset vs custom, call `GET /v1/voices`.

### Aggressive polling of `/v1/models`

Calling `GET /v1/models` in a tight loop (every 1-2 seconds) is unnecessary and wasteful. The model list changes rarely.

**Better alternatives:**

- Call `GET /v1/models` **once** at startup to populate a model list
- Use `GET /health` for periodic liveness checks (lightweight, no model load)
- Use `GET /v1/status` to check model load state if needed

### Missing required `text` field

The `text` field is required for all TTS endpoints. Omitting it returns `422 Unprocessable Entity`.

```bash
# WRONG — missing text
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"speaker": "ryan"}'

# CORRECT
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "speaker": "ryan"}'
```

### Minimal working examples

**Simplest possible preset TTS call (all defaults from `.env`):**

```bash
curl -X POST http://localhost:8880/v1/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello"}' \
  --output hello.wav
```

**Simplest possible clone TTS call (using default custom voice from `.env`):**

```bash
curl -X POST http://localhost:8880/v1/tts/clone \
  -F "text=Hello" \
  --output hello.wav
```

**Discovery calls (all GET, no body):**

```bash
curl http://localhost:8880/health            # Liveness
curl http://localhost:8880/v1/voices          # Voice list
curl http://localhost:8880/v1/emotions        # Emotion presets
curl http://localhost:8880/v1/config          # Active defaults
curl http://localhost:8880/v1/status          # Server/model status
```

---

_Generated for Qwen3 Voice Studio v5.1.0 - Local AI Voice API for Apple Silicon_

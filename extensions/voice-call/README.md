# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **ThreeCX** (Direct SIP/UDP via drachtio-srf — works with any SIP trunk provider)
- **Mock** (dev/no network)

Docs: `https://docs.openclaw.ai/plugins/voice-call`
Plugin system: `https://docs.openclaw.ai/plugin`

## Install (local dev)

### Option A: install via OpenClaw (recommended)

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.openclaw/extensions
cp -R extensions/voice-call ~/.openclaw/extensions/voice-call
cd ~/.openclaw/extensions/voice-call && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",

  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token",
  },

  telnyx: {
    apiKey: "KEYxxxx",
    connectionId: "CONNxxxx",
    // Telnyx webhook public key from the Telnyx Mission Control Portal
    // (Base64 string; can also be set via TELNYX_PUBLIC_KEY).
    publicKey: "...",
  },

  plivo: {
    authId: "MAxxxxxxxxxxxxxxxxxxxx",
    authToken: "your_token",
  },

  // Webhook server
  serve: {
    port: 3334,
    path: "/voice/webhook",
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify", // or "conversation"
  },

  streaming: {
    enabled: true,
    streamPath: "/voice/stream",
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  },
}
```

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Use for local dev only.

Streaming security defaults:

- `streaming.preStartTimeoutMs` closes sockets that never send a valid `start` frame.
- `streaming.maxPendingConnections` caps total unauthenticated pre-start sockets.
- `streaming.maxPendingConnectionsPerIp` caps unauthenticated pre-start sockets per source IP.
- `streaming.maxConnections` caps total open media stream sockets (pending + active).

## Stale call reaper

Use `staleCallReaperSeconds` to end calls that never receive a terminal webhook
(for example, notify-mode calls that never complete). The default is `0`
(disabled).

Recommended ranges:

- **Production:** `120`–`300` seconds for notify-style flows.
- Keep this value **higher than `maxDurationSeconds`** so normal calls can
  finish. A good starting point is `maxDurationSeconds + 30–60` seconds.

Example:

```json5
{
  staleCallReaperSeconds: 360,
}
```

## TTS for calls

Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for
streaming speech on calls. You can override it under the plugin config with the
same shape — overrides deep-merge with `messages.tts`.

```json5
{
  tts: {
    provider: "openai",
    openai: {
      voice: "alloy",
    },
  },
}
```

Notes:

- Edge TTS is ignored for voice calls (telephony audio needs PCM; Edge output is unreliable).
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider native voices.

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Tool

Tool name: `voice_call`

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?)
- `voicecall.continue` (callId, message)
- `voicecall.speak` (callId, message)
- `voicecall.end` (callId)
- `voicecall.status` (callId)

## ThreeCX Provider (Direct SIP)

The `threecx` provider connects directly to a SIP trunk provider (e.g. CrazyTel)
via UDP SIP, bypassing 3CX entirely. It uses **drachtio-server** as the SIP engine.

### Prerequisites

1. **drachtio-server** running as a Docker container:

```bash
docker run -d --name drachtio \
  --net=host \
  -e DRACHTIO_SECRET=cymru \
  drachtio/drachtio-server:latest
```

> `--net=host` is required because SIP/RTP need direct UDP network access
> (dynamic RTP ports can't be mapped). The container is lightweight (~50MB).

2. SIP trunk credentials from your provider (e.g. CrazyTel, VoIP.ms, etc.)

### Config

```json5
{
  provider: "threecx",
  threecx: {
    server: "sip.biz.crazytel.net.au", // SIP registrar host
    extension: "10301626", // SIP username
    password: "your-sip-password", // SIP password
    domain: "sip.biz.crazytel.net.au", // SIP domain
    // drachtio-server connection (defaults shown)
    drachtioHost: "127.0.0.1",
    drachtioPort: 9022,
    drachtioSecret: "cymru",
    // RTP port range (defaults shown)
    rtpPortMin: 21000,
    rtpPortMax: 21100,
  },
}
```

### How It Works

1. drachtio-server sends SIP REGISTER to your SIP trunk provider
2. Inbound calls arrive as SIP INVITE; OpenClaw auto-answers with G.711 audio
3. RTP audio flows directly between Node.js and the SIP trunk
4. Inbound G.711 is decoded to PCM and fed to STT; TTS output is encoded back to G.711

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- Adds replay protection for Twilio and Plivo webhooks (valid duplicate callbacks are ignored safely).
- Twilio speech turns include a per-turn token so stale/replayed callbacks cannot complete a newer turn.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Media streaming requires `ws` and OpenAI Realtime API key.
- ThreeCX provider uses SIP events (not HTTP webhooks) — no public URL or tunnel needed.

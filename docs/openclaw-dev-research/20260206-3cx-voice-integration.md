# 3CX Voice Integration - Research & Architecture

**Date:** 2026-02-06
**Status:** Phase 2 implementation complete (ThreeCXProvider + MediaBridge)

## Overview

Integration of 3CX cloud PBX with OpenClaw's voice-call extension, enabling AI-powered
phone conversations over standard telephony (PSTN).

## Infrastructure

| Component          | Details                              |
| ------------------ | ------------------------------------ |
| 3CX Instance       | Cloud-hosted PBX                     |
| SIP Trunk          | CrazyTel (registered, green)         |
| DID                | Australian number (E.164 format)     |
| Protocol           | SIP over WebSocket (WSS)             |
| WebSocket Endpoint | `wss://<instance>.3cx.cloud:5001/ws` |

## Architecture

```
Phone Caller
    |
    | PSTN
    v
CrazyTel SIP Trunk
    |
    | SIP
    v
3CX Cloud PBX (IVR / Ring Group)
    |
    | WSS (SIP over WebSocket)
    v
SIP.js UserAgent (ThreeCXProvider)
    |
    | WebRTC Audio
    v
ThreeCXMediaBridge
    |                    |
    v                    v
STT (PCM 16kHz)    TTS (PCM 16kHz)
    |                    |
    v                    v
AI Agent          Audio Response
```

## Key Technical Decisions

### SIP.js over REST API

3CX cloud-hosted has limited REST/webhook support. SIP.js connects directly
via WebSocket as a SIP extension, providing full call control without
needing webhooks, tunnels, or public URLs.

**Advantages over webhook-based providers (Twilio/Telnyx/Plivo):**

- No public webhook URL needed (no ngrok/Tailscale funnel)
- Direct SIP registration as a PBX extension
- Full call control (answer, reject, transfer, hold)
- Works behind NAT/firewalls (outbound WebSocket)

### Server-Side WebRTC

SIP.js normally uses browser WebRTC APIs. For server-side Node.js,
options include:

- `@roamhq/wrtc` - Node.js WebRTC bindings (recommended)
- `werift` - Pure TypeScript WebRTC implementation
- SIP.js's built-in SessionDescriptionHandler

The ThreeCXMediaBridge abstracts the WebRTC implementation, allowing
any of these to be plugged in.

### Audio Pipeline

```
Telephony: mu-law 8kHz (G.711)
         |
         | (conversion in ThreeCXMediaBridge)
         v
STT/TTS: PCM 16-bit signed LE, 16kHz mono
```

- Inbound audio (caller -> AI): Extract remote WebRTC track, decode to PCM,
  resample to 16kHz, forward to OpenAI Realtime STT
- Outbound audio (AI -> caller): Generate TTS audio, resample to WebRTC rate,
  inject into local audio track

Reuses existing `telephony-audio.ts` for mu-law/PCM conversion.

## Configuration

```yaml
plugins:
  entries:
    voice-call:
      config:
        enabled: true
        provider: threecx
        threecx:
          server: "wss://INSTANCE.3cx.cloud:5001/ws"
          extension: "EXTENSION_NUMBER"
          password: "SIP_PASSWORD"
          domain: "INSTANCE.3cx.cloud"
```

Environment variables (fallbacks):

- `THREECX_SERVER` - WebSocket URL
- `THREECX_EXTENSION` - Extension number
- `THREECX_PASSWORD` - SIP password
- `THREECX_DOMAIN` - SIP domain

## Files Created/Modified

### New Files

- `extensions/voice-call/src/providers/threecx.ts` - ThreeCXProvider (VoiceCallProvider impl)
- `extensions/voice-call/src/providers/threecx-media.ts` - WebRTC audio bridge
- `extensions/voice-call/src/providers/threecx.test.ts` - Unit tests

### Modified Files

- `extensions/voice-call/package.json` - Added `sip.js` dependency
- `extensions/voice-call/src/types.ts` - Added `"threecx"` to ProviderNameSchema
- `extensions/voice-call/src/config.ts` - Added ThreeCXConfigSchema + env resolution + validation
- `extensions/voice-call/src/providers/index.ts` - Export ThreeCXProvider + MediaBridge
- `extensions/voice-call/openclaw.plugin.json` - Added threecx config schema + UI hints

## Call Flow: Inbound

1. Phone caller dials DID number
2. PSTN routes to CrazyTel SIP trunk
3. CrazyTel forwards to 3CX cloud PBX
4. 3CX routes to OpenClaw extension (IVR/direct/ring group)
5. SIP INVITE arrives via WebSocket to SIP.js UserAgent
6. ThreeCXProvider auto-answers and creates ThreeCXMediaBridge
7. Remote audio extracted, converted to PCM, sent to STT
8. STT transcript forwarded to AI agent
9. Agent response converted to TTS audio
10. TTS audio injected into WebRTC track, sent to caller

## Call Flow: Outbound

1. AI agent triggers voice_call tool
2. ThreeCXProvider creates SIP INVITE via SIP.js
3. INVITE routed through 3CX PBX outbound rules
4. 3CX routes via CrazyTel SIP trunk to PSTN
5. When answered, media bridge established (same as inbound steps 7-10)

## Testing

Unit tests cover:

- Provider construction and config validation
- Webhook no-op verification (SIP uses WebSocket)
- Session management (missing callId warnings)
- Event listener lifecycle
- Media bridge capture/inject
- Audio resampling (48kHz -> 16kHz)
- Bridge lifecycle (close, error states)

Run: `pnpm test extensions/voice-call/src/providers/threecx.test.ts`

## Next Steps

- [ ] Phase 1: Create dedicated extension in 3CX admin and configure routing
- [ ] Phase 1: Test basic inbound/outbound calls through 3CX web client
- [ ] Phase 2: Integrate server-side WebRTC library (@roamhq/wrtc or werift)
- [ ] Phase 2: End-to-end test with real 3CX instance
- [ ] Phase 2: Add DTMF support for IVR navigation
- [ ] Phase 2: Add call transfer capability

# Bugfix: ThreeCX Inbound Calls Silent (No Voice Response)

**Date:** 2026-02-17
**Reported by:** Matthew Cage
**Symptom:** Inbound calls to the minervarette agent via 3CX are answered but no voice is heard -- the agent is completely silent.

---

## Root Cause Analysis

Three interconnected bugs in the voice-call extension caused a complete failure of the inbound call voice pipeline for the ThreeCX provider.

### Bug 1: CallId Mismatch (Critical -- STT Never Starts)

**Files:** `providers/threecx.ts`, `runtime.ts`, `manager/events.ts`

**Problem:** ThreeCX and CallManager each generate independent UUIDs for the same call. ThreeCX stores SIP sessions under its own UUID (`this.sessions.set(callId, session)`), but when CallManager processes the event, it creates a **different** UUID and overwrites `event.callId`. When runtime.ts then calls `startListening({ callId: event.callId })`, ThreeCX cannot find the session because it uses a different key.

**Flow (before fix):**

1. ThreeCX generates `callId = "abc-123"`, stores `sessions["abc-123"] = session`
2. ThreeCX emits event with `callId: "abc-123"`
3. CallManager processes event, creates call with `callId: "xyz-789"`, mutates `event.callId = "xyz-789"`
4. Runtime calls `startListening({ callId: "xyz-789" })`
5. ThreeCX: `sessions.get("xyz-789")` → **undefined** → STT never starts → agent is deaf

**Log evidence:**

```
[threecx] startListening: no session for callId dc5fb5f7-...
```

**Fix:**

- Added `callIdAliases` map and `findSession()` helper to ThreeCXProvider that resolves external callIds (from CallManager) to internal session keys
- Added `registerCallIdAlias()` public method
- Replaced all `this.sessions.get(callId)` in provider methods (`startListening`, `playTts`, `hangupCall`, `stopListening`, `clearTts`, `getMediaBridge`) with `this.findSession(callId)`
- In `runtime.ts`, the event listener now captures the original callId before `processEvent` mutates it, and registers the alias with ThreeCX

### Bug 2: Initial Greeting Deadlock

**Files:** `manager.ts`

**Problem:** `speakInitialMessage()` explicitly skipped playback for ThreeCX calls:

```ts
if (this.provider?.name === "threecx") {
  console.log("skipping for 3CX (conversation loop handles TTS)");
  return;
}
```

The comment assumed the conversation loop would handle the greeting, but the conversation loop only activates after the **user speaks first**. This created a deadlock: the agent waited for the user to speak, and the user waited for the agent to say something.

**Log evidence:**

```
[voice-call] speakInitialMessage: skipping for 3CX (conversation loop handles TTS)
```

**Fix:**

- Removed the 3CX-specific skip from `speakInitialMessage()`
- Replaced the inline implementation (which had a latent `this.persistCallRecord is not a function` bug) with a clean delegation to the existing `speakInitialMessageWithContext()` helper from `manager/outbound.ts`
- The inbound greeting configured in `openclaw.json` (`"Hi, this is Minervarette. What's up?"`) will now be spoken immediately when the call is answered

### Bug 3: Duplicate Call Records (3 Records per Call)

**Files:** `manager/events.ts`

**Problem:** ThreeCX emits three events per inbound call (`call.initiated`, `call.ringing`, `call.answered`), each carrying the same ThreeCX-internal callId. After the first event creates a CallManager call record, subsequent events could not find it because:

1. `findCall(event.callId)` looks up ThreeCX's UUID in `activeCalls` → not found (stored under CallManager UUID)
2. Falls back to `getCallByProviderCallId(threecx-uuid)` → not found (only the SIP Call-ID is mapped, not the ThreeCX UUID)

Result: each event created a **new** call record, producing 3 records for 1 physical call.

**Fix:**

- In `events.ts`, after creating an inbound call and overwriting `event.callId`, also map the original ThreeCX callId in `providerCallIdMap` so subsequent events can be correlated:

```ts
if (originalCallId && originalCallId !== call.callId) {
  ctx.providerCallIdMap.set(originalCallId, call.callId);
}
```

### Bug 4 (Minor): Config Validation Warning

**Symptom:** `Invalid config: threecx: must NOT have additional properties` in logs.

**Status:** The `freeswitchSecret` property IS defined in the plugin's `configSchema` (in `openclaw.plugin.json`). This was likely a stale error from an earlier schema version cached by the gateway. No code change needed.

---

## Files Changed

| File                   | Change                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/threecx.ts` | Added `callIdAliases` map, `registerCallIdAlias()`, `findSession()` helper; replaced 6x `sessions.get()` calls with `findSession()`; cleanup aliases on session end |
| `runtime.ts`           | Capture original callId before `processEvent` mutation; register alias with ThreeCX                                                                                 |
| `manager.ts`           | Removed 3CX skip in `speakInitialMessage()`; replaced buggy inline implementation with delegation to `speakInitialMessageWithContext()`                             |
| `manager/events.ts`    | Map original provider callId in `providerCallIdMap` after creating inbound call record                                                                              |

## Test Results

All 117 voice-call tests pass (11 test files):

- `threecx.test.ts`: 57 passed
- `manager.test.ts`: 7 passed
- `events.test.ts`: 6 passed
- All other test files: 47 passed

---

## Expected Behavior After Fix

1. Inbound call arrives via 3CX/drachtio SIP
2. CallManager creates a single call record (not 3 duplicates)
3. ThreeCX callId is aliased to CallManager callId
4. `speakInitialMessage` plays the configured greeting ("Hi, this is Minervarette. What's up?")
5. STT starts successfully (session found via alias lookup)
6. User speaks → conversation loop generates AI response → TTS plays back
7. Full bidirectional voice conversation works

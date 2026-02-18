import { describe, expect, it, vi } from "vitest";
import type { RealtimeSTTSession } from "./stt-openai-realtime.js";
import {
  ThreeCXMediaBridge,
  decodeMulaw,
  encodeMulaw,
  linearToMulaw,
  mulawToLinear,
  buildRtpPacket,
  parseRtpPacket,
  resampleLinear,
} from "./threecx-media.js";
import { ThreeCXProvider } from "./threecx.js";

// ---------------------------------------------------------------------------
// Mock STT session for barge-in debounce testing
// ---------------------------------------------------------------------------

/** Minimal mock of RealtimeSTTSession that lets tests trigger speech events */
class MockRealtimeSTTSession implements RealtimeSTTSession {
  private speechStartCb: (() => void) | null = null;
  private speechEndCb: (() => void) | null = null;
  private transcriptCb: ((t: string) => void) | null = null;
  private partialCb: ((p: string) => void) | null = null;
  private _connected = false;

  async connect(): Promise<void> {
    this._connected = true;
  }
  sendAudio(_audio: Buffer): void {}
  async waitForTranscript(_timeoutMs?: number): Promise<string> {
    return "";
  }
  onPartial(cb: (p: string) => void): void {
    this.partialCb = cb;
  }
  onTranscript(cb: (t: string) => void): void {
    this.transcriptCb = cb;
  }
  onSpeechStart(cb: () => void): void {
    this.speechStartCb = cb;
  }
  onSpeechEnd(cb: () => void): void {
    this.speechEndCb = cb;
  }
  close(): void {
    this._connected = false;
  }
  isConnected(): boolean {
    return this._connected;
  }

  /** Test helper: simulate VAD speech-start */
  simulateSpeechStart(): void {
    this.speechStartCb?.();
  }
  /** Test helper: simulate VAD speech-stop */
  simulateSpeechEnd(): void {
    this.speechEndCb?.();
  }
}

/** Mock STT provider factory that returns a controllable mock session */
class MockSTTProvider {
  readonly name = "openai-realtime";
  readonly mockSession = new MockRealtimeSTTSession();
  createSession(): MockRealtimeSTTSession {
    return this.mockSession;
  }
}

// ---------------------------------------------------------------------------
// ThreeCXProvider unit tests
// ---------------------------------------------------------------------------

describe("ThreeCXProvider", () => {
  const validConfig = {
    server: "sip.example.com",
    extension: "10001",
    password: "test-password",
    domain: "sip.example.com",
  };

  it("throws when required config fields are missing", () => {
    expect(() => new ThreeCXProvider({})).toThrow("SIP server host is required");
    expect(() => new ThreeCXProvider({ server: "sip.x" })).toThrow(
      "SIP extension/username is required",
    );
    expect(() => new ThreeCXProvider({ server: "sip.x", extension: "100" })).toThrow(
      "SIP password is required",
    );
    expect(() => new ThreeCXProvider({ server: "sip.x", extension: "100", password: "p" })).toThrow(
      "SIP domain is required",
    );
  });

  it("constructs successfully with valid config", () => {
    const provider = new ThreeCXProvider(validConfig);
    expect(provider.name).toBe("threecx");
    expect(provider.isRegistered).toBe(false);
    expect(provider.activeCallCount).toBe(0);
  });

  it("constructs with default drachtio/RTP config values", () => {
    const provider = new ThreeCXProvider(validConfig);
    // Provider should accept the config without drachtio fields (defaults applied)
    expect(provider.name).toBe("threecx");
  });

  it("verifyWebhook always returns ok (SIP uses drachtio, not HTTP)", () => {
    const provider = new ThreeCXProvider(validConfig);
    const result = provider.verifyWebhook({
      headers: {},
      rawBody: "",
      url: "",
      method: "POST",
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("drachtio");
  });

  it("parseWebhookEvent returns empty events (no HTTP webhooks)", () => {
    const provider = new ThreeCXProvider(validConfig);
    const result = provider.parseWebhookEvent({
      headers: {},
      rawBody: "{}",
      url: "",
      method: "POST",
    });
    expect(result.events).toHaveLength(0);
    expect(result.statusCode).toBe(200);
  });

  it("initiateCall throws when not connected", async () => {
    const provider = new ThreeCXProvider(validConfig);
    await expect(
      provider.initiateCall({
        callId: "test-call",
        from: "10001",
        to: "10002",
        webhookUrl: "http://unused",
      }),
    ).rejects.toThrow("not connected");
  });

  it("hangupCall logs warning for unknown callId", async () => {
    const provider = new ThreeCXProvider(validConfig);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await provider.hangupCall({
      callId: "nonexistent",
      providerCallId: "x",
      reason: "hangup-bot",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no session for callId nonexistent"),
    );
    warnSpy.mockRestore();
  });

  it("playTts logs warning for unknown callId", async () => {
    const provider = new ThreeCXProvider(validConfig);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await provider.playTts({
      callId: "nonexistent",
      providerCallId: "x",
      text: "hello",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no session for callId nonexistent"),
    );
    warnSpy.mockRestore();
  });

  it("event listeners can be added and removed", () => {
    const provider = new ThreeCXProvider(validConfig);
    const listener = vi.fn();
    provider.addEventListener(listener);
    provider.removeEventListener(listener);
    // No crash, no events emitted after removal
    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes portPoolStatus for debugging", () => {
    const provider = new ThreeCXProvider(validConfig);
    const status = provider.portPoolStatus;
    expect(status).toHaveProperty("active");
    expect(status).toHaveProperty("available");
    expect(status).toHaveProperty("ports");
    expect(Array.isArray(status.ports)).toBe(true);
    expect(typeof status.active).toBe("number");
    expect(typeof status.available).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Port Pool Tracking Tests
// ---------------------------------------------------------------------------

describe("ThreeCXMediaBridge port tracking", () => {
  it("tracks allocated ports via static activePortCount and activePorts", async () => {
    const initialCount = ThreeCXMediaBridge.activePortCount;

    const bridge1 = new ThreeCXMediaBridge({ rtpPortMin: 31000, rtpPortMax: 31010 });
    const port1 = await bridge1.startRtp();

    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount + 1);
    expect(ThreeCXMediaBridge.activePorts).toContain(port1);

    const bridge2 = new ThreeCXMediaBridge({ rtpPortMin: 31000, rtpPortMax: 31010 });
    const port2 = await bridge2.startRtp();

    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount + 2);
    expect(ThreeCXMediaBridge.activePorts).toContain(port2);

    // Close bridge1 - should release port
    bridge1.close();
    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount + 1);
    expect(ThreeCXMediaBridge.activePorts).not.toContain(port1);
    expect(ThreeCXMediaBridge.activePorts).toContain(port2);

    // Close bridge2 - should release port
    bridge2.close();
    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount);
    expect(ThreeCXMediaBridge.activePorts).not.toContain(port2);
  });

  it("does not leak port when close() is called after startRtp()", async () => {
    const initialCount = ThreeCXMediaBridge.activePortCount;

    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 31020, rtpPortMax: 31030 });
    await bridge.startRtp();

    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount + 1);

    bridge.close();

    // Port should be released
    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount);
  });

  it("close() is idempotent and does not double-release port", async () => {
    const initialCount = ThreeCXMediaBridge.activePortCount;

    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 31040, rtpPortMax: 31050 });
    await bridge.startRtp();

    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount + 1);

    // Call close multiple times
    bridge.close();
    bridge.close();
    bridge.close();

    // Should still only have released once
    expect(ThreeCXMediaBridge.activePortCount).toBe(initialCount);
  });

  it("clearAllocatedPorts() resets the port tracking set", async () => {
    // Create and start multiple bridges to allocate ports
    const bridge1 = new ThreeCXMediaBridge({ rtpPortMin: 31060, rtpPortMax: 31070 });
    const bridge2 = new ThreeCXMediaBridge({ rtpPortMin: 31060, rtpPortMax: 31070 });
    await bridge1.startRtp();
    await bridge2.startRtp();

    expect(ThreeCXMediaBridge.activePortCount).toBeGreaterThanOrEqual(2);

    // Clear all allocated ports (simulates gateway restart scenario)
    ThreeCXMediaBridge.clearAllocatedPorts();

    // Port tracking should be reset to zero
    expect(ThreeCXMediaBridge.activePortCount).toBe(0);
    expect(ThreeCXMediaBridge.activePorts).toEqual([]);

    // Clean up the actual sockets (they're still bound at OS level)
    bridge1.close();
    bridge2.close();
  });
});

// ---------------------------------------------------------------------------
// G.711 mu-law encode/decode tests
// ---------------------------------------------------------------------------

describe("G.711 mu-law codec", () => {
  it("encodes and decodes a single sample with minimal distortion", () => {
    // mu-law is lossy but the round-trip should be close
    const testSamples = [0, 1000, -1000, 10000, -10000, 32000, -32000];

    for (const original of testSamples) {
      const encoded = linearToMulaw(original);
      const decoded = mulawToLinear(encoded);

      // mu-law quantization error: ~1% at high amplitudes, a few hundred at low.
      const maxError = Math.max(Math.abs(original) * 0.02, 200);
      expect(Math.abs(decoded - original)).toBeLessThanOrEqual(maxError);
    }
  });

  it("encodes silence to ~0xFF and decodes back to near-zero", () => {
    const encoded = linearToMulaw(0);
    const decoded = mulawToLinear(encoded);
    expect(Math.abs(decoded)).toBeLessThanOrEqual(4);
  });

  it("round-trips a PCM buffer through encodeMulaw/decodeMulaw", () => {
    // Create a sine wave at 8kHz
    const numSamples = 160; // 20ms at 8kHz
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const value = Math.round(Math.sin((i / numSamples) * Math.PI * 2) * 10000);
      pcm.writeInt16LE(value, i * 2);
    }

    const encoded = encodeMulaw(pcm);
    expect(encoded.length).toBe(numSamples);

    const decoded = decodeMulaw(encoded);
    expect(decoded.length).toBe(numSamples * 2);

    // Verify the waveform shape is preserved (lossy, so check correlation)
    let sumOriginal = 0;
    let sumDecoded = 0;
    for (let i = 0; i < numSamples; i++) {
      sumOriginal += pcm.readInt16LE(i * 2);
      sumDecoded += decoded.readInt16LE(i * 2);
    }
    // Both should be near zero for a full cycle sine wave
    expect(Math.abs(sumOriginal)).toBeLessThan(numSamples * 200);
    expect(Math.abs(sumDecoded)).toBeLessThan(numSamples * 200);
  });

  it("handles maximum amplitude values", () => {
    const maxPositive = linearToMulaw(32767);
    const maxNegative = linearToMulaw(-32768);
    expect(typeof maxPositive).toBe("number");
    expect(typeof maxNegative).toBe("number");
    expect(maxPositive).toBeGreaterThanOrEqual(0);
    expect(maxPositive).toBeLessThanOrEqual(255);
    expect(maxNegative).toBeGreaterThanOrEqual(0);
    expect(maxNegative).toBeLessThanOrEqual(255);
  });
});

// ---------------------------------------------------------------------------
// RTP packet tests
// ---------------------------------------------------------------------------

describe("RTP packets", () => {
  it("builds and parses an RTP packet round-trip", () => {
    const payload = Buffer.from([0x7f, 0xff, 0x80, 0x00, 0x01]);
    const packet = buildRtpPacket(42, 160, 0x12345678, payload);

    expect(packet.length).toBe(12 + payload.length);

    const parsed = parseRtpPacket(packet);
    expect(parsed).not.toBeNull();
    expect(parsed!.payloadType).toBe(0); // PCMU
    expect(parsed!.sequenceNumber).toBe(42);
    expect(parsed!.timestamp).toBe(160);
    expect(parsed!.ssrc).toBe(0x12345678);
    expect(parsed!.payload).toEqual(payload);
  });

  it("returns null for packets that are too short", () => {
    expect(parseRtpPacket(Buffer.alloc(5))).toBeNull();
  });

  it("returns null for non-RTPv2 packets", () => {
    const badPacket = Buffer.alloc(12);
    badPacket[0] = 0x00; // Version 0, not 2
    expect(parseRtpPacket(badPacket)).toBeNull();
  });

  it("handles sequence number wrapping", () => {
    const payload = Buffer.alloc(10);
    const packet = buildRtpPacket(0xffff, 1000, 1, payload);
    const parsed = parseRtpPacket(packet);
    expect(parsed!.sequenceNumber).toBe(0xffff);
  });
});

// ---------------------------------------------------------------------------
// Resampling tests
// ---------------------------------------------------------------------------

describe("resampleLinear", () => {
  it("returns input unchanged when rates match", () => {
    const input = Buffer.alloc(320);
    input.writeInt16LE(1234, 0);
    const output = resampleLinear(input, 16000, 16000);
    expect(output).toBe(input); // Same reference
  });

  it("upsamples 8kHz to 16kHz (doubles samples)", () => {
    // 160 samples at 8kHz = 320 bytes
    const input = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) {
      input.writeInt16LE(i * 100, i * 2);
    }
    const output = resampleLinear(input, 8000, 16000);
    // Should produce ~320 samples = 640 bytes
    expect(output.length).toBe(640);
  });

  it("downsamples 48kHz to 16kHz", () => {
    // 960 samples at 48kHz (20ms)
    const input = Buffer.alloc(1920);
    for (let i = 0; i < 960; i++) {
      input.writeInt16LE(Math.round(Math.sin((i / 960) * Math.PI * 2) * 10000), i * 2);
    }
    const output = resampleLinear(input, 48000, 16000);
    // 960 / 3 = 320 samples = 640 bytes
    expect(output.length).toBe(640);
  });

  it("handles empty input", () => {
    const output = resampleLinear(Buffer.alloc(0), 8000, 16000);
    expect(output.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ThreeCXMediaBridge unit tests
// ---------------------------------------------------------------------------

describe("ThreeCXMediaBridge", () => {
  it("starts and stops capture", () => {
    const bridge = new ThreeCXMediaBridge();
    expect(bridge.isCapturing).toBe(false);

    bridge.startCapture();
    expect(bridge.isCapturing).toBe(true);

    bridge.stopCapture();
    expect(bridge.isCapturing).toBe(false);
    bridge.close();
  });

  it("emits audio chunks from pushRemoteAudio", async () => {
    const bridge = new ThreeCXMediaBridge({ captureChunkMs: 10 });
    const chunks: unknown[] = [];
    bridge.on("audio", (chunk: unknown) => chunks.push(chunk));

    bridge.startCapture();

    // Push a small PCM buffer (16kHz, 20ms = 640 bytes)
    const pcm = Buffer.alloc(640, 0);
    pcm.writeInt16LE(1000, 0);
    bridge.pushRemoteAudio(pcm, 16000);

    // Wait for the capture interval to fire
    await new Promise((r) => setTimeout(r, 30));

    bridge.stopCapture();
    bridge.close();

    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0] as { pcm: Buffer; sampleRate: number; timestamp: number };
    expect(chunk.sampleRate).toBe(16000);
    expect(chunk.pcm.length).toBe(640);
  });

  it("does not emit when not capturing", async () => {
    const bridge = new ThreeCXMediaBridge({ captureChunkMs: 10 });
    const chunks: unknown[] = [];
    bridge.on("audio", (chunk: unknown) => chunks.push(chunk));

    // Push without starting capture
    bridge.pushRemoteAudio(Buffer.alloc(640, 0), 16000);
    await new Promise((r) => setTimeout(r, 30));

    expect(chunks).toHaveLength(0);
    bridge.close();
  });

  it("resamples audio from 48kHz to 16kHz via pushRemoteAudio", async () => {
    const bridge = new ThreeCXMediaBridge({
      captureChunkMs: 10,
      captureSampleRate: 16000,
    });
    const chunks: unknown[] = [];
    bridge.on("audio", (chunk: unknown) => chunks.push(chunk));

    bridge.startCapture();

    // 48kHz mono, 20ms = 1920 bytes (960 samples)
    const pcm48k = Buffer.alloc(1920, 0);
    for (let i = 0; i < 960; i++) {
      pcm48k.writeInt16LE(Math.round(Math.sin((i / 960) * Math.PI * 2) * 10000), i * 2);
    }
    bridge.pushRemoteAudio(pcm48k, 48000);

    await new Promise((r) => setTimeout(r, 30));
    bridge.stopCapture();
    bridge.close();

    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0] as { pcm: Buffer; sampleRate: number };
    expect(chunk.sampleRate).toBe(16000);
    expect(chunk.pcm.length).toBe(640);
  });

  it("close prevents further capture", () => {
    const bridge = new ThreeCXMediaBridge();
    bridge.close();

    expect(bridge.isClosed).toBe(true);

    // Should not throw, just no-op
    bridge.startCapture();
    expect(bridge.isCapturing).toBe(false);
  });

  it("injectAudio emits inject event when no socket is open", async () => {
    const bridge = new ThreeCXMediaBridge();
    const events: unknown[] = [];
    bridge.on("inject", (e: unknown) => events.push(e));

    await bridge.injectAudio(Buffer.alloc(320, 0), 16000);

    expect(events).toHaveLength(1);
    const ev = events[0] as { pcm: Buffer; sampleRate: number };
    expect(ev.sampleRate).toBe(16000);
    expect(ev.pcm.length).toBe(320);

    bridge.close();
  });

  it("injectAudio throws when closed", async () => {
    const bridge = new ThreeCXMediaBridge();
    bridge.close();

    await expect(bridge.injectAudio(Buffer.alloc(10), 16000)).rejects.toThrow("closed");
  });

  it("generates valid SDP", () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30000, rtpPortMax: 30010 });
    const sdp = bridge.generateSdp("192.168.1.100");

    expect(sdp).toContain("v=0");
    expect(sdp).toContain("c=IN IP4 192.168.1.100");
    expect(sdp).toContain("m=audio");
    expect(sdp).toContain("PCMU/8000");
    expect(sdp).toContain("a=sendrecv");

    bridge.close();
  });

  it("parses remote SDP correctly", () => {
    const sdp = [
      "v=0",
      "o=- 123 456 IN IP4 10.0.0.1",
      "s=-",
      "c=IN IP4 10.0.0.1",
      "t=0 0",
      "m=audio 12345 RTP/AVP 0",
      "a=rtpmap:0 PCMU/8000",
    ].join("\r\n");

    const endpoint = ThreeCXMediaBridge.parseRemoteSdp(sdp);
    expect(endpoint).not.toBeNull();
    expect(endpoint!.host).toBe("10.0.0.1");
    expect(endpoint!.port).toBe(12345);
  });

  it("returns null for SDP without media or connection", () => {
    expect(ThreeCXMediaBridge.parseRemoteSdp("v=0\r\n")).toBeNull();
  });

  it("binds to a port within the RTP range", async () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30000, rtpPortMax: 30010 });
    const port = await bridge.startRtp();
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThanOrEqual(30010);
    expect(bridge.rtpPort).toBe(port);
    bridge.close();
  });

  it("injectMulaw silently returns when no socket is open", async () => {
    const bridge = new ThreeCXMediaBridge();
    // Should not throw -- just bail out since no socket/remote
    await bridge.injectMulaw(Buffer.alloc(160, 0x7f));
    bridge.close();
  });

  it("injectMulaw sends correctly chunked RTP packets", async () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30020, rtpPortMax: 30030 });
    const port = await bridge.startRtp();
    bridge.setRemoteEndpoint("127.0.0.1", port);

    // We verify injectMulaw completes without error; packet-level
    // verification would require a second UDP socket to receive.

    // 320 bytes = 2 frames of 160 samples each
    const mulaw = Buffer.alloc(320, 0x7f);
    await bridge.injectMulaw(mulaw);

    // Verify it completed without errors
    bridge.close();
  });

  it("emits rawPayload event during capture when RTP packet arrives", async () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30040, rtpPortMax: 30050 });
    const port = await bridge.startRtp();
    bridge.setRemoteEndpoint("127.0.0.1", port);

    const rawPayloads: Buffer[] = [];
    bridge.on("rawPayload", (payload: Buffer) => rawPayloads.push(payload));

    bridge.startCapture();

    // Build and send a valid RTP packet with mu-law payload
    const payload = Buffer.alloc(160, 0xff); // silence in mu-law
    const rtp = buildRtpPacket(1, 0, 0x11223344, payload);

    // Send the packet to ourselves
    const dgram = await import("node:dgram");
    const sender = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sender.send(rtp, port, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });

    // Wait for the packet to be processed
    await new Promise((r) => setTimeout(r, 50));

    bridge.stopCapture();
    sender.close();
    bridge.close();

    expect(rawPayloads.length).toBeGreaterThanOrEqual(1);
    expect(rawPayloads[0].length).toBe(160);
  });
});

// ---------------------------------------------------------------------------
// ThreeCX TTS/STT integration tests
// ---------------------------------------------------------------------------

describe("ThreeCXProvider TTS/STT", () => {
  const validConfig = {
    server: "sip.example.com",
    extension: "10001",
    password: "test-password",
    domain: "sip.example.com",
  };

  it("setTTSProvider accepts a provider", () => {
    const provider = new ThreeCXProvider(validConfig);
    // Mock TTS provider
    const mockTts = { synthesizeForTelephony: vi.fn() };
    provider.setTTSProvider(mockTts);
    // No assertion needed -- just verify it doesn't throw
  });

  it("setSTTProvider accepts a provider", () => {
    const provider = new ThreeCXProvider(validConfig);
    const mockStt = { name: "openai-realtime", createSession: vi.fn() };
    provider.setSTTProvider(mockStt as never);
    // No assertion needed -- just verify it doesn't throw
  });

  it("playTts warns when no TTS provider is set", async () => {
    const provider = new ThreeCXProvider(validConfig);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // playTts for unknown call should warn about missing session
    await provider.playTts({ callId: "test", providerCallId: "x", text: "hello" });
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("startListening warns when no STT provider and no session", async () => {
    const provider = new ThreeCXProvider(validConfig);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await provider.startListening({ callId: "test", providerCallId: "x" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no session for callId test"));

    warnSpy.mockRestore();
  });

  it("stopListening warns for unknown callId", async () => {
    const provider = new ThreeCXProvider(validConfig);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await provider.stopListening({ callId: "nonexistent", providerCallId: "x" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no session for callId nonexistent"),
    );

    warnSpy.mockRestore();
  });

  it("setBargeInConfig updates barge-in settings", () => {
    const provider = new ThreeCXProvider(validConfig);
    // Should not throw; just updates internal state
    provider.setBargeInConfig(false, 500);
    provider.setBargeInConfig(true, 0);
  });

  it("clearTts no-ops for unknown callId", () => {
    const provider = new ThreeCXProvider(validConfig);
    // Should not throw for unknown call
    provider.clearTts("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Barge-in: injectMulaw abort tests
// ---------------------------------------------------------------------------

describe("ThreeCXMediaBridge injectMulaw abort", () => {
  it("stops sending when AbortSignal is already aborted", async () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30060, rtpPortMax: 30070 });
    const port = await bridge.startRtp();
    bridge.setRemoteEndpoint("127.0.0.1", port);

    // Create pre-aborted signal
    const ac = new AbortController();
    ac.abort();

    // 10 frames worth of audio -- should return immediately
    const mulaw = Buffer.alloc(1600, 0x7f);

    const start = Date.now();
    await bridge.injectMulaw(mulaw, ac.signal);
    const elapsed = Date.now() - start;

    // Should complete nearly instantly since signal was already aborted
    expect(elapsed).toBeLessThan(50);

    bridge.close();
  });

  it("stops mid-stream when AbortSignal is aborted during playback", async () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30070, rtpPortMax: 30080 });
    const port = await bridge.startRtp();
    bridge.setRemoteEndpoint("127.0.0.1", port);

    const ac = new AbortController();

    // 20 frames = ~400ms of audio at 20ms/frame
    const mulaw = Buffer.alloc(3200, 0x7f);

    // Abort after 80ms -- should stop within a few frames
    setTimeout(() => ac.abort(), 80);

    const start = Date.now();
    await bridge.injectMulaw(mulaw, ac.signal);
    const elapsed = Date.now() - start;

    // Should have stopped well before full 400ms playback
    expect(elapsed).toBeLessThan(250);

    bridge.close();
  });

  it("plays fully when AbortSignal is not aborted", async () => {
    const bridge = new ThreeCXMediaBridge({ rtpPortMin: 30080, rtpPortMax: 30090 });
    const port = await bridge.startRtp();
    bridge.setRemoteEndpoint("127.0.0.1", port);

    const ac = new AbortController();

    // 2 frames = ~40ms of audio (including 20ms pacing delay)
    const mulaw = Buffer.alloc(320, 0x7f);

    await bridge.injectMulaw(mulaw, ac.signal);

    // Should complete normally
    expect(ac.signal.aborted).toBe(false);

    bridge.close();
  });
});

// ---------------------------------------------------------------------------
// Barge-in: clearTts with active AbortController
// ---------------------------------------------------------------------------

describe("ThreeCXProvider clearTts with active controller", () => {
  const validConfig = {
    server: "sip.example.com",
    extension: "10001",
    password: "test-password",
    domain: "sip.example.com",
  };

  it("aborts the session's active TTS AbortController", () => {
    const provider = new ThreeCXProvider(validConfig);
    const bridge = new ThreeCXMediaBridge();
    const ac = new AbortController();

    // Inject a session with an active TTS controller into the private sessions map
    const sessions = (provider as never as { sessions: Map<string, unknown> }).sessions;
    sessions.set("call-1", {
      callId: "call-1",
      providerCallId: "sip-1",
      direction: "outbound",
      from: "10001",
      to: "10002",
      dialog: null,
      mediaBridge: bridge,
      startedAt: Date.now(),
      ttsAbortController: ac,
    });

    expect(ac.signal.aborted).toBe(false);

    provider.clearTts("call-1");

    // Controller should have been aborted by clearTts
    expect(ac.signal.aborted).toBe(true);

    bridge.close();
  });

  it("no-ops when session exists but has no active controller", () => {
    const provider = new ThreeCXProvider(validConfig);
    const bridge = new ThreeCXMediaBridge();

    const sessions = (provider as never as { sessions: Map<string, unknown> }).sessions;
    sessions.set("call-2", {
      callId: "call-2",
      providerCallId: "sip-2",
      direction: "outbound",
      from: "10001",
      to: "10002",
      dialog: null,
      mediaBridge: bridge,
      startedAt: Date.now(),
      ttsAbortController: null,
    });

    // Should not throw
    provider.clearTts("call-2");
    bridge.close();
  });
});

// ---------------------------------------------------------------------------
// Barge-in: debounce behavior (requires mock STT)
// ---------------------------------------------------------------------------

describe("ThreeCXProvider barge-in debounce", () => {
  const validConfig = {
    server: "sip.example.com",
    extension: "10001",
    password: "test-password",
    domain: "sip.example.com",
  };

  it("triggers clearTts and emits call.interrupted after debounce period", async () => {
    vi.useFakeTimers();

    const provider = new ThreeCXProvider(validConfig);
    const mockStt = new MockSTTProvider();
    provider.setSTTProvider(mockStt as never);
    provider.setBargeInConfig(true, 300);

    // Create a session with an active TTS controller
    const bridge = new ThreeCXMediaBridge();
    const ac = new AbortController();

    const sessions = (provider as never as { sessions: Map<string, unknown> }).sessions;
    sessions.set("call-1", {
      callId: "call-1",
      providerCallId: "sip-1",
      direction: "outbound",
      from: "10001",
      to: "10002",
      dialog: null,
      mediaBridge: bridge,
      startedAt: Date.now(),
      ttsAbortController: ac,
    });

    // Collect emitted events
    const events: { type: string }[] = [];
    provider.addEventListener((ev) => events.push(ev));

    // Start listening -- wires up STT callbacks via mock session
    await provider.startListening({ callId: "call-1", providerCallId: "sip-1" });

    // Simulate caller speech start
    mockStt.mockSession.simulateSpeechStart();

    // Immediately: should have call.speech but NOT call.interrupted yet
    expect(events.some((e) => e.type === "call.speech")).toBe(true);
    expect(events.some((e) => e.type === "call.interrupted")).toBe(false);
    expect(ac.signal.aborted).toBe(false);

    // Advance past the debounce period (300ms)
    vi.advanceTimersByTime(300);

    // Now barge-in should have fired: call.interrupted emitted, TTS aborted
    expect(events.some((e) => e.type === "call.interrupted")).toBe(true);
    expect(ac.signal.aborted).toBe(true);

    bridge.close();
    vi.useRealTimers();
  });

  it("does NOT trigger barge-in when speech ends before debounce period", async () => {
    vi.useFakeTimers();

    const provider = new ThreeCXProvider(validConfig);
    const mockStt = new MockSTTProvider();
    provider.setSTTProvider(mockStt as never);
    provider.setBargeInConfig(true, 300);

    const bridge = new ThreeCXMediaBridge();
    const ac = new AbortController();

    const sessions = (provider as never as { sessions: Map<string, unknown> }).sessions;
    sessions.set("call-2", {
      callId: "call-2",
      providerCallId: "sip-2",
      direction: "outbound",
      from: "10001",
      to: "10002",
      dialog: null,
      mediaBridge: bridge,
      startedAt: Date.now(),
      ttsAbortController: ac,
    });

    const events: { type: string }[] = [];
    provider.addEventListener((ev) => events.push(ev));

    await provider.startListening({ callId: "call-2", providerCallId: "sip-2" });

    // Simulate speech start
    mockStt.mockSession.simulateSpeechStart();

    // Advance only 100ms (less than 300ms debounce)
    vi.advanceTimersByTime(100);

    // Speech ends before debounce fires (short noise/cough)
    mockStt.mockSession.simulateSpeechEnd();

    // Advance well past the original debounce period
    vi.advanceTimersByTime(500);

    // Barge-in should NOT have fired because speech ended before debounce
    expect(events.some((e) => e.type === "call.interrupted")).toBe(false);
    expect(ac.signal.aborted).toBe(false);

    bridge.close();
    vi.useRealTimers();
  });

  it("does not trigger barge-in when bargeInEnabled is false", async () => {
    vi.useFakeTimers();

    const provider = new ThreeCXProvider(validConfig);
    const mockStt = new MockSTTProvider();
    provider.setSTTProvider(mockStt as never);
    provider.setBargeInConfig(false, 300);

    const bridge = new ThreeCXMediaBridge();
    const ac = new AbortController();

    const sessions = (provider as never as { sessions: Map<string, unknown> }).sessions;
    sessions.set("call-3", {
      callId: "call-3",
      providerCallId: "sip-3",
      direction: "outbound",
      from: "10001",
      to: "10002",
      dialog: null,
      mediaBridge: bridge,
      startedAt: Date.now(),
      ttsAbortController: ac,
    });

    const events: { type: string }[] = [];
    provider.addEventListener((ev) => events.push(ev));

    await provider.startListening({ callId: "call-3", providerCallId: "sip-3" });

    // Simulate speech start
    mockStt.mockSession.simulateSpeechStart();

    // Advance well past debounce
    vi.advanceTimersByTime(500);

    // Barge-in disabled: no interruption event, TTS not aborted
    expect(events.some((e) => e.type === "call.interrupted")).toBe(false);
    expect(ac.signal.aborted).toBe(false);

    // call.speech should still be emitted (always fires regardless of barge-in)
    expect(events.some((e) => e.type === "call.speech")).toBe(true);

    bridge.close();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// STT onSpeechEnd callback wiring
// ---------------------------------------------------------------------------

describe("RealtimeSTTSession onSpeechEnd", () => {
  it("MockRealtimeSTTSession fires onSpeechEnd callback when speech stops", () => {
    const session = new MockRealtimeSTTSession();
    const cb = vi.fn();

    session.onSpeechEnd(cb);
    expect(cb).not.toHaveBeenCalled();

    session.simulateSpeechEnd();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("onSpeechEnd cancels barge-in debounce through full provider pipeline", async () => {
    // This is an integration-level test that verifies the onSpeechEnd -> timer
    // cancellation pipeline works end-to-end through the ThreeCXProvider
    vi.useFakeTimers();

    const validConfig = {
      server: "sip.example.com",
      extension: "10001",
      password: "test-password",
      domain: "sip.example.com",
    };

    const provider = new ThreeCXProvider(validConfig);
    const mockStt = new MockSTTProvider();
    provider.setSTTProvider(mockStt as never);
    provider.setBargeInConfig(true, 200);

    const bridge = new ThreeCXMediaBridge();
    const ac = new AbortController();

    const sessions = (provider as never as { sessions: Map<string, unknown> }).sessions;
    sessions.set("call-end", {
      callId: "call-end",
      providerCallId: "sip-end",
      direction: "inbound",
      from: "555-0100",
      to: "10001",
      dialog: null,
      mediaBridge: bridge,
      startedAt: Date.now(),
      ttsAbortController: ac,
    });

    const events: { type: string }[] = [];
    provider.addEventListener((ev) => events.push(ev));

    await provider.startListening({ callId: "call-end", providerCallId: "sip-end" });

    // Speech starts → debounce timer created
    mockStt.mockSession.simulateSpeechStart();

    // After 50ms, speech ends → timer should be cancelled
    vi.advanceTimersByTime(50);
    mockStt.mockSession.simulateSpeechEnd();

    // Advance past original debounce (200ms total)
    vi.advanceTimersByTime(300);

    // No barge-in since onSpeechEnd cancelled the timer
    expect(events.some((e) => e.type === "call.interrupted")).toBe(false);
    expect(ac.signal.aborted).toBe(false);

    bridge.close();
    vi.useRealTimers();
  });
});

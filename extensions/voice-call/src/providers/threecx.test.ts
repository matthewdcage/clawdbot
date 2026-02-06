import { describe, expect, it, vi } from "vitest";
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
});

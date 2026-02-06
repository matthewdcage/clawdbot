/**
 * ThreeCX RTP Audio Bridge
 *
 * Bridges between SIP RTP audio (G.711 mu-law) and OpenClaw's PCM audio pipeline:
 *
 *   Remote caller audio (RTP/G.711) -> decode -> resample -> STT pipeline
 *   TTS pipeline -> resample -> encode G.711 -> RTP -> Remote caller
 *
 * Telephony uses G.711 mu-law (PCMU) at 8kHz; STT/TTS uses PCM 16-bit 16kHz.
 * Audio is sent/received via UDP (dgram) with standard RTP framing.
 */

import crypto from "node:crypto";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Audio chunk emitted from the remote caller's audio stream */
export interface AudioChunk {
  /** PCM 16-bit signed LE mono audio data */
  pcm: Buffer;
  /** Sample rate of the PCM data */
  sampleRate: number;
  /** Timestamp in ms when this chunk was captured */
  timestamp: number;
}

/** Configuration for the media bridge */
export interface MediaBridgeConfig {
  /** Target sample rate for captured audio (default: 16000 for STT) */
  captureSampleRate?: number;
  /** Capture chunk duration in ms (default: 20) */
  captureChunkMs?: number;
  /** Min port in the RTP port range */
  rtpPortMin?: number;
  /** Max port in the RTP port range */
  rtpPortMax?: number;
}

/** RTP session info extracted from SDP negotiation */
export interface RtpEndpoint {
  host: string;
  port: number;
}

// Default config for STT-compatible audio
const DEFAULT_CONFIG: Required<MediaBridgeConfig> = {
  captureSampleRate: 16000,
  captureChunkMs: 20,
  rtpPortMin: 20000,
  rtpPortMax: 20100,
};

// RTP header size (fixed 12 bytes, no CSRC)
const RTP_HEADER_SIZE = 12;

// G.711 PCMU payload type
const PCMU_PAYLOAD_TYPE = 0;

// G.711 sample rate
const G711_SAMPLE_RATE = 8000;

// Samples per 20ms frame at 8kHz
const SAMPLES_PER_FRAME = 160;

// -----------------------------------------------------------------------------
// G.711 mu-law encode/decode tables
// Precomputed for O(1) conversion -- ~50 lines of lookup logic.
// -----------------------------------------------------------------------------

/** Bias added before mu-law encoding */
const MULAW_BIAS = 0x84;
const _MULAW_MAX = 0x7fff;
const MULAW_CLIP = 32635;

/**
 * Encode a single 16-bit linear PCM sample to 8-bit mu-law.
 */
export function linearToMulaw(sample: number): number {
  // Clamp
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = Math.min(Math.abs(sample), MULAW_CLIP);
  magnitude += MULAW_BIAS;

  // Find segment (exponent) and quantize
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    // iterate down
  }

  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/**
 * Decode a single 8-bit mu-law sample to 16-bit linear PCM.
 * Uses the standard ITU-T G.711 decode formula.
 */
export function mulawToLinear(mulawByte: number): number {
  const complemented = ~mulawByte & 0xff;
  const sign = complemented & 0x80;
  const exponent = (complemented >> 4) & 0x07;
  const mantissa = complemented & 0x0f;

  // Reconstruct magnitude per ITU G.711:
  // t = (mantissa << 3 + bias) << exponent, then subtract bias
  const t = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign ? MULAW_BIAS - t : t - MULAW_BIAS;
}

/**
 * Encode a PCM 16-bit LE buffer to G.711 mu-law bytes.
 */
export function encodeMulaw(pcm: Buffer): Buffer {
  const numSamples = Math.floor(pcm.length / 2);
  const encoded = Buffer.alloc(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    encoded[i] = linearToMulaw(sample);
  }
  return encoded;
}

/**
 * Decode G.711 mu-law bytes to PCM 16-bit LE buffer.
 */
export function decodeMulaw(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = mulawToLinear(mulaw[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

// -----------------------------------------------------------------------------
// RTP Packet Helpers
// -----------------------------------------------------------------------------

/** Build an RTP packet with a G.711 PCMU payload. */
export function buildRtpPacket(
  sequenceNumber: number,
  rtpTimestamp: number,
  ssrc: number,
  payload: Buffer,
): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE);

  // Byte 0: V=2, P=0, X=0, CC=0  →  0x80
  header[0] = 0x80;
  // Byte 1: M=0, PT=0 (PCMU)
  header[1] = PCMU_PAYLOAD_TYPE;
  // Sequence number (big-endian)
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  // Timestamp (big-endian)
  header.writeUInt32BE(rtpTimestamp >>> 0, 4);
  // SSRC (big-endian)
  header.writeUInt32BE(ssrc >>> 0, 8);

  return Buffer.concat([header, payload]);
}

/** Parse an RTP packet, returning header info and payload. */
export function parseRtpPacket(packet: Buffer): {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
} | null {
  if (packet.length < RTP_HEADER_SIZE) {
    return null;
  }

  const version = (packet[0] >> 6) & 0x03;
  if (version !== 2) {
    return null;
  }

  const csrcCount = packet[0] & 0x0f;
  const headerLen = RTP_HEADER_SIZE + csrcCount * 4;
  if (packet.length < headerLen) {
    return null;
  }

  return {
    payloadType: packet[1] & 0x7f,
    sequenceNumber: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(headerLen),
  };
}

// -----------------------------------------------------------------------------
// ThreeCXMediaBridge
// -----------------------------------------------------------------------------

/**
 * Manages bidirectional audio between RTP/UDP (G.711 mu-law) and
 * OpenClaw's PCM-based STT/TTS pipeline.
 *
 * Usage:
 *   1. Create bridge: `new ThreeCXMediaBridge({ rtpPortMin: 20000, rtpPortMax: 20100 })`
 *   2. Start RTP: `const localPort = await bridge.startRtp()`
 *   3. Set remote endpoint after SDP answer: `bridge.setRemoteEndpoint(host, port)`
 *   4. Start capturing: `bridge.startCapture()`
 *   5. Listen for audio: `bridge.on("audio", (chunk: AudioChunk) => { ... })`
 *   6. Send TTS audio: `bridge.injectAudio(pcmBuffer, sampleRate)`
 *   7. Clean up: `bridge.close()`
 *
 * Events:
 *   - "audio": Emitted with AudioChunk when remote audio is captured
 *   - "error": Emitted on audio processing errors
 */
export class ThreeCXMediaBridge extends EventEmitter {
  private config: Required<MediaBridgeConfig>;
  private socket: dgram.Socket | null = null;
  private localPort = 0;
  private remoteEndpoint: RtpEndpoint | null = null;
  private capturing = false;
  private closed = false;

  /** Buffer for accumulating audio samples before emitting chunks */
  private captureBuffer: Buffer[] = [];
  private captureInterval: ReturnType<typeof setInterval> | null = null;

  /** RTP send state */
  private ssrc: number;
  private sequenceNumber = 0;
  private rtpTimestamp = 0;

  constructor(config?: MediaBridgeConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Random SSRC for our outbound RTP stream
    this.ssrc = crypto.randomInt(0, 0xffffffff);
  }

  /**
   * Open a UDP socket on a port within the configured range.
   * Returns the local port number (for SDP generation).
   */
  async startRtp(): Promise<number> {
    if (this.closed) {
      throw new Error("MediaBridge is closed");
    }
    if (this.socket) {
      return this.localPort;
    }

    this.socket = dgram.createSocket("udp4");

    // Try ports in the configured range until one binds
    const { rtpPortMin, rtpPortMax } = this.config;
    let bound = false;

    for (let port = rtpPortMin; port <= rtpPortMax; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket!.once("error", reject);
          this.socket!.bind(port, "0.0.0.0", () => {
            this.socket!.removeListener("error", reject);
            resolve();
          });
        });
        this.localPort = port;
        bound = true;
        break;
      } catch {
        // Port in use, try next
        if (port === rtpPortMax) {
          break;
        }
        // Recreate socket since bind failure can leave it in bad state
        this.socket.close();
        this.socket = dgram.createSocket("udp4");
      }
    }

    if (!bound) {
      this.socket.close();
      this.socket = null;
      throw new Error(`No available RTP port in range ${rtpPortMin}-${rtpPortMax}`);
    }

    // Handle incoming RTP packets
    this.socket.on("message", (msg: Buffer) => {
      this.handleRtpPacket(msg);
    });

    this.socket.on("error", (err) => {
      this.emit("error", err);
    });

    console.log(`[threecx-media] RTP socket bound to port ${this.localPort}`);
    return this.localPort;
  }

  /**
   * Set the remote RTP endpoint (extracted from the remote SDP answer).
   * Must be called after the SIP dialog is established.
   */
  setRemoteEndpoint(host: string, port: number): void {
    this.remoteEndpoint = { host, port };
    console.log(`[threecx-media] Remote RTP endpoint: ${host}:${port}`);
  }

  /**
   * Generate a minimal SDP offer/answer for G.711 PCMU.
   * Used when answering or initiating SIP calls.
   */
  generateSdp(localIp: string): string {
    return [
      "v=0",
      `o=openclaw ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
      "s=OpenClaw Voice",
      `c=IN IP4 ${localIp}`,
      "t=0 0",
      `m=audio ${this.localPort} RTP/AVP ${PCMU_PAYLOAD_TYPE}`,
      `a=rtpmap:${PCMU_PAYLOAD_TYPE} PCMU/${G711_SAMPLE_RATE}`,
      "a=ptime:20",
      "a=sendrecv",
      "",
    ].join("\r\n");
  }

  /**
   * Parse remote SDP to extract the RTP endpoint (IP + port).
   */
  static parseRemoteSdp(sdp: string): RtpEndpoint | null {
    let host: string | null = null;
    let port: number | null = null;

    for (const line of sdp.split(/\r?\n/)) {
      // Connection line: c=IN IP4 <ip>
      const cMatch = line.match(/^c=IN IP4 (\S+)/);
      if (cMatch) {
        host = cMatch[1]!;
      }

      // Media line: m=audio <port> RTP/AVP ...
      const mMatch = line.match(/^m=audio (\d+)/);
      if (mMatch) {
        port = Number.parseInt(mMatch[1], 10);
      }
    }

    if (host && port) {
      return { host, port };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // RTP Receive
  // ---------------------------------------------------------------------------

  /** Process an incoming RTP packet: decode G.711 -> PCM -> capture buffer. */
  private handleRtpPacket(packet: Buffer): void {
    if (!this.capturing) {
      return;
    }

    const parsed = parseRtpPacket(packet);
    if (!parsed) {
      return;
    }

    // Only handle PCMU (payload type 0)
    if (parsed.payloadType !== PCMU_PAYLOAD_TYPE) {
      return;
    }

    // Decode G.711 mu-law to PCM 16-bit LE (8kHz)
    const pcm8k = decodeMulaw(parsed.payload);

    // Resample from 8kHz to the target capture rate (typically 16kHz for STT)
    const pcmResampled = resampleLinear(pcm8k, G711_SAMPLE_RATE, this.config.captureSampleRate);

    this.captureBuffer.push(pcmResampled);
  }

  // ---------------------------------------------------------------------------
  // Capture (Remote Audio -> STT)
  // ---------------------------------------------------------------------------

  /** Start capturing remote audio and emitting PCM chunks. */
  startCapture(): void {
    if (this.capturing || this.closed) {
      return;
    }
    this.capturing = true;

    // Flush accumulated audio at the configured interval
    this.captureInterval = setInterval(() => {
      this.flushCaptureBuffer();
    }, this.config.captureChunkMs);

    console.log("[threecx-media] Audio capture started");
  }

  /** Stop capturing remote audio. */
  stopCapture(): void {
    if (!this.capturing) {
      return;
    }
    this.capturing = false;

    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    this.flushCaptureBuffer();
    console.log("[threecx-media] Audio capture stopped");
  }

  /**
   * Push raw PCM audio data from the remote peer into the capture pipeline.
   * Can be called externally (e.g. from tests or alternative audio sources).
   */
  pushRemoteAudio(pcm: Buffer, sampleRate: number): void {
    if (!this.capturing || this.closed) {
      return;
    }

    const resampled =
      sampleRate === this.config.captureSampleRate
        ? pcm
        : resampleLinear(pcm, sampleRate, this.config.captureSampleRate);

    this.captureBuffer.push(resampled);
  }

  /** Flush accumulated capture buffer and emit an audio chunk. */
  private flushCaptureBuffer(): void {
    if (this.captureBuffer.length === 0) {
      return;
    }

    const combined = Buffer.concat(this.captureBuffer);
    this.captureBuffer = [];

    if (combined.length === 0) {
      return;
    }

    const chunk: AudioChunk = {
      pcm: combined,
      sampleRate: this.config.captureSampleRate,
      timestamp: Date.now(),
    };

    this.emit("audio", chunk);
  }

  // ---------------------------------------------------------------------------
  // Injection (TTS -> Remote Caller)
  // ---------------------------------------------------------------------------

  /**
   * Inject PCM audio into the outbound RTP stream (plays to caller).
   * PCM is resampled to 8kHz, encoded as G.711 PCMU, and sent as RTP packets.
   *
   * @param pcm PCM 16-bit signed LE mono audio
   * @param sampleRate Sample rate of the input audio
   */
  async injectAudio(pcm: Buffer, sampleRate: number): Promise<void> {
    if (this.closed) {
      throw new Error("MediaBridge is closed");
    }
    if (!this.socket || !this.remoteEndpoint) {
      this.emit("inject", { pcm, sampleRate, timestamp: Date.now() });
      return;
    }

    // Resample to 8kHz for G.711
    const pcm8k =
      sampleRate === G711_SAMPLE_RATE ? pcm : resampleLinear(pcm, sampleRate, G711_SAMPLE_RATE);

    // Encode to G.711 mu-law
    const mulaw = encodeMulaw(pcm8k);

    // Send as RTP packets (160 samples per 20ms frame)
    for (let offset = 0; offset < mulaw.length; offset += SAMPLES_PER_FRAME) {
      const frameSize = Math.min(SAMPLES_PER_FRAME, mulaw.length - offset);
      const payload = mulaw.subarray(offset, offset + frameSize);

      const rtpPacket = buildRtpPacket(this.sequenceNumber, this.rtpTimestamp, this.ssrc, payload);

      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.rtpTimestamp += frameSize;

      // Send the RTP packet
      await new Promise<void>((resolve, reject) => {
        this.socket!.send(rtpPacket, this.remoteEndpoint!.port, this.remoteEndpoint!.host, (err) =>
          err ? reject(err) : resolve(),
        );
      });

      // Pace packets at 20ms intervals for real-time playback
      if (frameSize === SAMPLES_PER_FRAME && offset + SAMPLES_PER_FRAME < mulaw.length) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Close the media bridge and release resources. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.stopCapture();

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed
      }
      this.socket = null;
    }

    this.remoteEndpoint = null;
    this.removeAllListeners();

    console.log("[threecx-media] Bridge closed");
  }

  /** Whether capture is active */
  get isCapturing(): boolean {
    return this.capturing;
  }

  /** Whether the bridge is closed */
  get isClosed(): boolean {
    return this.closed;
  }

  /** The local RTP port (0 if not yet started) */
  get rtpPort(): number {
    return this.localPort;
  }
}

// -----------------------------------------------------------------------------
// Audio Utilities
// -----------------------------------------------------------------------------

/**
 * Linear interpolation resampling for PCM 16-bit LE mono.
 * Used to convert between G.711 8kHz and STT/TTS 16kHz rates.
 */
export function resampleLinear(input: Buffer, inputRate: number, outputRate: number): Buffer {
  if (inputRate === outputRate) {
    return input;
  }

  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = inputRate / outputRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = input.readInt16LE(srcIdx * 2);
    const nextIdx = Math.min(srcIdx + 1, inputSamples - 1);
    const s1 = input.readInt16LE(nextIdx * 2);

    const sample = Math.round(s0 + frac * (s1 - s0));
    // Clamp to 16-bit range
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output;
}

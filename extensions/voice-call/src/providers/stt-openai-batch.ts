/**
 * OpenAI Standard Whisper API STT Provider
 *
 * Uses the standard OpenAI /v1/audio/transcriptions endpoint (batch mode)
 * with local VAD. Shares the same local VAD + audio accumulation approach
 * as the Whisper MLX provider, but sends audio to the OpenAI API instead
 * of running locally.
 *
 * Trade-offs vs other providers:
 * - vs openai-realtime: higher latency (batch), but simpler and cheaper
 * - vs whisper-mlx: requires API key and network, but no local GPU needed
 *
 * Audio pipeline: mu-law 8 kHz -> PCM 16-bit -> resample 16 kHz -> WAV -> OpenAI API
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { STTProvider, STTSession } from "./stt-base.js";

// ---------------------------------------------------------------------------
// G.711 mu-law decode (shared with whisper-mlx — keep in sync or extract)
// ---------------------------------------------------------------------------

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const inv = ~i & 0xff;
  const sign = inv & 0x80;
  const exponent = (inv >> 4) & 0x07;
  const mantissa = inv & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  MULAW_DECODE[i] = sign !== 0 ? -magnitude & 0xffff : magnitude;
}

function decodeMuLawBuffer(mulaw: Buffer): Int16Array {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    pcm[i] = MULAW_DECODE[mulaw[i]!]!;
  }
  return pcm;
}

function resample8to16(pcm8k: Int16Array): Int16Array {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = pcm8k[i]!;
    const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1]! : s0;
    out[i * 2] = s0;
    out[i * 2 + 1] = ((s0 + s1) >> 1) as number;
  }
  return out;
}

function pcmToWav(pcm16k: Int16Array): Buffer {
  const dataLen = pcm16k.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm16k.length; i++) {
    buf.writeInt16LE(pcm16k[i]!, 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OpenAIBatchSTTConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Whisper model name (default: whisper-1) */
  model?: string;
  /** Silence duration (ms) before VAD considers speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD energy threshold 0-1 (default: 0.03). Lower = more sensitive. */
  vadThreshold?: number;
  /** Language hint for Whisper (e.g. "en"). Omit for auto-detect. */
  language?: string;
}

// ---------------------------------------------------------------------------
// Provider (factory)
// ---------------------------------------------------------------------------

export class OpenAIBatchSTTProvider implements STTProvider {
  readonly name = "openai";
  readonly silenceDurationMs: number;
  readonly vadThreshold: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language?: string;

  constructor(config: OpenAIBatchSTTConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for standard Whisper STT");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "whisper-1";
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.vadThreshold = config.vadThreshold ?? 0.03;
    this.language = config.language;
  }

  createSession(): STTSession {
    return new OpenAIBatchSTTSession(
      this.apiKey,
      this.model,
      this.silenceDurationMs,
      this.vadThreshold,
      this.language,
    );
  }
}

// ---------------------------------------------------------------------------
// STT Session (per-call) — local VAD + OpenAI batch transcription
// ---------------------------------------------------------------------------

const VAD_FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_SEC = 30;
const MAX_UTTERANCE_SAMPLES_8K = MAX_UTTERANCE_SEC * 8000;

class OpenAIBatchSTTSession implements STTSession {
  private connected = false;
  private closed = false;

  // Audio accumulation
  private speechBuffer: number[] = [];

  // VAD state
  private isSpeaking = false;
  private silenceFrames = 0;
  private speechFrames = 0;
  private silenceFrameThreshold: number;
  private speechStartFrameThreshold = 3;

  // Callbacks
  private onTranscriptCb: ((transcript: string) => void) | null = null;
  private onPartialCb: ((partial: string) => void) | null = null;
  private onSpeechStartCb: (() => void) | null = null;
  private onSpeechEndCb: (() => void) | null = null;
  private waitResolve: ((text: string) => void) | null = null;
  private waitReject: ((err: Error) => void) | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private transcribing = false;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    silenceDurationMs: number,
    private readonly vadThreshold: number,
    private readonly language?: string,
  ) {
    this.silenceFrameThreshold = Math.max(1, Math.round(silenceDurationMs / 20));
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.closed = false;
    console.log("[openai-batch-stt] Session connected");
  }

  sendAudio(mulaw: Buffer): void {
    if (!this.connected || this.closed) return;
    const pcm = decodeMuLawBuffer(mulaw);
    for (let offset = 0; offset < pcm.length; offset += VAD_FRAME_SAMPLES) {
      const end = Math.min(offset + VAD_FRAME_SAMPLES, pcm.length);
      this.processVadFrame(pcm.subarray(offset, end));
    }
  }

  private processVadFrame(frame: Int16Array): void {
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      const sample = frame[i]! / 32768;
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / frame.length);
    const isSpeechFrame = rms > this.vadThreshold;

    if (!this.isSpeaking) {
      if (isSpeechFrame) {
        this.speechFrames++;
        for (let i = 0; i < frame.length; i++) this.speechBuffer.push(frame[i]!);
        if (this.speechFrames >= this.speechStartFrameThreshold) {
          this.isSpeaking = true;
          this.silenceFrames = 0;
          this.onSpeechStartCb?.();
        }
      } else {
        this.speechFrames = 0;
        this.speechBuffer.length = 0;
      }
    } else {
      for (let i = 0; i < frame.length; i++) this.speechBuffer.push(frame[i]!);
      if (isSpeechFrame) {
        this.silenceFrames = 0;
      } else {
        this.silenceFrames++;
        if (this.silenceFrames >= this.silenceFrameThreshold) {
          this.isSpeaking = false;
          this.speechFrames = 0;
          this.silenceFrames = 0;
          this.onSpeechEndCb?.();
          void this.processUtterance();
        }
      }
      if (this.speechBuffer.length > MAX_UTTERANCE_SAMPLES_8K) {
        this.isSpeaking = false;
        this.speechFrames = 0;
        this.silenceFrames = 0;
        this.onSpeechEndCb?.();
        void this.processUtterance();
      }
    }
  }

  /** Convert accumulated audio to WAV, POST to OpenAI Whisper API. */
  private async processUtterance(): Promise<void> {
    if (this.transcribing) return;
    const pcm8k = new Int16Array(this.speechBuffer);
    this.speechBuffer.length = 0;

    const minSamples = (MIN_SPEECH_MS / 1000) * 8000;
    if (pcm8k.length < minSamples) return;

    this.transcribing = true;
    try {
      this.onPartialCb?.("[transcribing...]");

      const pcm16k = resample8to16(pcm8k);
      const wav = pcmToWav(pcm16k);

      // Write temp file (OpenAI API needs a file upload)
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-stt-"));
      const wavPath = path.join(tmpDir, "utterance.wav");
      await fs.writeFile(wavPath, wav);

      try {
        const text = await this.callWhisperApi(wavPath);
        if (text) {
          console.log(`[openai-batch-stt] Transcript: ${text}`);
          this.onTranscriptCb?.(text);
          if (this.waitResolve) {
            if (this.waitTimer) clearTimeout(this.waitTimer);
            this.waitResolve(text);
            this.waitResolve = null;
            this.waitReject = null;
            this.waitTimer = null;
          }
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      console.error(`[openai-batch-stt] Transcription error:`, err);
    } finally {
      this.transcribing = false;
    }
  }

  /** POST wav to /v1/audio/transcriptions */
  private async callWhisperApi(wavPath: string): Promise<string> {
    const fileData = await fs.readFile(wavPath);
    const boundary = `----FormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="utterance.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
    );
    parts.push(fileData);
    parts.push(Buffer.from("\r\n"));

    // model field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.model}\r\n`,
      ),
    );

    // language field (optional)
    if (this.language) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.language}\r\n`,
        ),
      );
    }

    // response_format
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
      ),
    );

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI Whisper API error ${resp.status}: ${errText}`);
    }
    const json = (await resp.json()) as { text?: string };
    return (json.text || "").trim();
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCb = callback;
  }
  onTranscript(callback: (transcript: string) => void): void {
    this.onTranscriptCb = callback;
  }
  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCb = callback;
  }
  onSpeechEnd(callback: () => void): void {
    this.onSpeechEndCb = callback;
  }
  async waitForTranscript(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.waitTimer = setTimeout(() => {
        this.waitResolve = null;
        this.waitReject = null;
        this.waitTimer = null;
        reject(new Error("Transcript timeout"));
      }, timeoutMs);
      this.waitResolve = resolve;
      this.waitReject = reject;
    });
  }
  close(): void {
    this.closed = true;
    this.connected = false;
    this.speechBuffer.length = 0;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.waitReject) {
      this.waitReject(new Error("Session closed"));
      this.waitResolve = null;
      this.waitReject = null;
    }
  }
  isConnected(): boolean {
    return this.connected && !this.closed;
  }
}

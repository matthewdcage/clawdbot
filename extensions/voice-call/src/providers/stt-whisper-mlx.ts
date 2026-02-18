/**
 * Whisper MLX STT Provider
 *
 * Runs speech-to-text locally on Apple Silicon using mlx-whisper.
 * Accepts streaming mu-law audio (8 kHz mono), performs local VAD
 * (voice activity detection), and transcribes speech segments via
 * a persistent Python subprocess to avoid model-reload latency.
 *
 * Audio pipeline: mu-law 8 kHz -> PCM 16-bit -> resample 16 kHz -> WAV -> mlx_whisper
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { STTProvider, STTSession } from "./stt-base.js";

// ---------------------------------------------------------------------------
// G.711 mu-law decode table (ITU-T G.711)
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

// ---------------------------------------------------------------------------
// Resample 8 kHz -> 16 kHz (linear interpolation)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WAV file writer (16 kHz, 16-bit, mono)
// ---------------------------------------------------------------------------

function pcmToWav(pcm16k: Int16Array): Buffer {
  const dataLen = pcm16k.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24); // sample rate
  buf.writeUInt32LE(32000, 28); // byte rate (16000 * 2)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  // PCM samples (little-endian)
  for (let i = 0; i < pcm16k.length; i++) {
    buf.writeInt16LE(pcm16k[i]!, 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WhisperMLXConfig {
  /** HuggingFace model repo or local path (default: mlx-community/whisper-large-v3-turbo) */
  model?: string;
  /** Silence duration (ms) before VAD considers speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD energy threshold 0-1 (default: 0.03). Lower = more sensitive. */
  vadThreshold?: number;
  /** Python executable path (default: python3) */
  pythonPath?: string;
  /** Language hint for Whisper (e.g. "en"). Omit for auto-detect. */
  language?: string;
}

// ---------------------------------------------------------------------------
// Provider (factory)
// ---------------------------------------------------------------------------

export class WhisperMLXSTTProvider implements STTProvider {
  readonly name = "whisper-mlx";
  readonly silenceDurationMs: number;
  readonly vadThreshold: number;
  private readonly model: string;
  private readonly pythonPath: string;
  private readonly language?: string;
  /** Shared persistent Python transcription subprocess */
  private worker: WhisperWorker | null = null;

  constructor(config: WhisperMLXConfig = {}) {
    this.model = config.model || "mlx-community/whisper-large-v3-turbo";
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.vadThreshold = config.vadThreshold ?? 0.03;
    this.pythonPath = config.pythonPath || "python3";
    this.language = config.language;
  }

  createSession(): STTSession {
    // Lazily start the persistent worker on first session
    if (!this.worker) {
      this.worker = new WhisperWorker(this.pythonPath, this.model, this.language);
    }
    return new WhisperMLXSTTSession(this.worker, this.silenceDurationMs, this.vadThreshold);
  }

  /** Shut down the persistent Python worker. */
  async shutdown(): Promise<void> {
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent Python worker (avoids model reload per utterance)
// ---------------------------------------------------------------------------

/**
 * Inline Python script that loads mlx_whisper once and accepts
 * transcription requests via stdin (one JSON line per request).
 * Each response is a JSON line on stdout.
 */
const WORKER_SCRIPT = `
import sys, json, os, traceback

def main():
    model_name = None
    language = None

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            req = json.loads(line.strip())
            cmd = req.get("cmd", "transcribe")

            if cmd == "init":
                model_name = req.get("model", "mlx-community/whisper-large-v3-turbo")
                language = req.get("language")
                # Pre-import to catch missing package early
                import mlx_whisper
                sys.stdout.write(json.dumps({"ok": True, "model": model_name}) + "\\n")
                sys.stdout.flush()
                continue

            if cmd == "transcribe":
                import mlx_whisper
                audio_path = req["file"]
                kw = {"path_or_hf_repo": model_name or "mlx-community/whisper-large-v3-turbo"}
                lang = req.get("language") or language
                if lang:
                    kw["language"] = lang
                result = mlx_whisper.transcribe(audio_path, **kw)
                text = result.get("text", "").strip()
                sys.stdout.write(json.dumps({"ok": True, "text": text}) + "\\n")
                sys.stdout.flush()
                # Clean up temp file
                try:
                    os.unlink(audio_path)
                except OSError:
                    pass
                continue

            if cmd == "ping":
                sys.stdout.write(json.dumps({"ok": True, "pong": True}) + "\\n")
                sys.stdout.flush()
                continue

        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc()}) + "\\n")
            sys.stdout.flush()

main()
`;

class WhisperWorker {
  private proc: ChildProcess | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private buffer = "";

  constructor(
    private readonly pythonPath: string,
    private readonly model: string,
    private readonly language?: string,
  ) {}

  /** Ensure the worker process is running and initialized. */
  async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.start();
    return this.initPromise;
  }

  private async start(): Promise<void> {
    this.proc = spawn(this.pythonPath, ["-u", "-c", WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout?.setEncoding("utf-8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf-8");
    this.proc.stderr?.on("data", (chunk: string) => {
      // mlx_whisper prints progress to stderr; log but don't treat as error
      for (const line of chunk.split("\n").filter(Boolean)) {
        console.log(`[whisper-mlx:stderr] ${line}`);
      }
    });
    this.proc.on("exit", (code) => {
      console.warn(`[whisper-mlx] Worker exited (code=${code})`);
      this.ready = false;
      this.proc = null;
      // Reject all pending requests
      for (const [, cb] of this.pending) {
        cb.reject(new Error(`Whisper MLX worker exited (code=${code})`));
      }
      this.pending.clear();
    });

    // Send init command
    const initResult = await this.send({ cmd: "init", model: this.model, language: this.language });
    if (!(initResult as { ok: boolean }).ok) {
      const err = (initResult as { error?: string }).error || "Unknown init error";
      throw new Error(`Whisper MLX init failed: ${err}`);
    }
    this.ready = true;
    console.log(`[whisper-mlx] Worker ready (model: ${this.model})`);
  }

  /** Send a JSON-line request and wait for the response. */
  async send(request: Record<string, unknown>): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Whisper MLX worker not running");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify({ ...request, _id: id }) + "\n";
      this.proc!.stdin!.write(line);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        // Resolve the oldest pending request (FIFO ordering matches stdin/stdout)
        const [firstKey] = this.pending.keys();
        if (firstKey !== undefined) {
          const cb = this.pending.get(firstKey)!;
          this.pending.delete(firstKey);
          cb.resolve(resp);
        }
      } catch {
        console.warn(`[whisper-mlx] Failed to parse worker response: ${line}`);
      }
    }
  }

  /** Transcribe a WAV file. Returns the transcript text. */
  async transcribe(wavPath: string): Promise<string> {
    await this.ensureReady();
    const resp = (await this.send({ cmd: "transcribe", file: wavPath })) as {
      ok: boolean;
      text?: string;
      error?: string;
    };
    if (!resp.ok) {
      throw new Error(`Whisper MLX transcription failed: ${resp.error}`);
    }
    return resp.text || "";
  }

  kill(): void {
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.ready = false;
  }
}

// ---------------------------------------------------------------------------
// STT Session (per-call)
// ---------------------------------------------------------------------------

/** VAD frame size: 20 ms at 8 kHz = 160 samples */
const VAD_FRAME_SAMPLES = 160;
/** Minimum speech duration (ms) to consider a valid utterance */
const MIN_SPEECH_MS = 250;
/** Maximum single-utterance duration (seconds) to prevent runaway buffers */
const MAX_UTTERANCE_SEC = 30;
const MAX_UTTERANCE_SAMPLES_8K = MAX_UTTERANCE_SEC * 8000;

class WhisperMLXSTTSession implements STTSession {
  private worker: WhisperWorker;
  private silenceDurationMs: number;
  private vadThreshold: number;
  private connected = false;
  private closed = false;

  // Audio accumulation
  private audioBuffer: number[] = [];
  private speechBuffer: number[] = [];

  // VAD state
  private isSpeaking = false;
  private silenceFrames = 0;
  private speechFrames = 0;
  /** How many consecutive silent frames = silenceDurationMs */
  private silenceFrameThreshold: number;
  /** How many consecutive speech frames to confirm speech start */
  private speechStartFrameThreshold = 3;

  // Callbacks
  private onTranscriptCb: ((transcript: string) => void) | null = null;
  private onPartialCb: ((partial: string) => void) | null = null;
  private onSpeechStartCb: (() => void) | null = null;
  private onSpeechEndCb: (() => void) | null = null;
  private waitResolve: ((text: string) => void) | null = null;
  private waitReject: ((err: Error) => void) | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  // Processing flag to avoid overlapping transcriptions
  private transcribing = false;

  constructor(worker: WhisperWorker, silenceDurationMs: number, vadThreshold: number) {
    this.worker = worker;
    this.silenceDurationMs = silenceDurationMs;
    this.vadThreshold = vadThreshold;
    // Each frame is 20 ms at 8 kHz
    this.silenceFrameThreshold = Math.max(1, Math.round(silenceDurationMs / 20));
  }

  async connect(): Promise<void> {
    await this.worker.ensureReady();
    this.connected = true;
    this.closed = false;
    console.log("[whisper-mlx] Session connected (local)");
  }

  sendAudio(mulaw: Buffer): void {
    if (!this.connected || this.closed) return;

    // Decode mu-law to 16-bit PCM samples
    const pcm = decodeMuLawBuffer(mulaw);

    // Process VAD frame-by-frame
    for (let offset = 0; offset < pcm.length; offset += VAD_FRAME_SAMPLES) {
      const end = Math.min(offset + VAD_FRAME_SAMPLES, pcm.length);
      const frame = pcm.subarray(offset, end);
      this.processVadFrame(frame);
    }
  }

  private processVadFrame(frame: Int16Array): void {
    // Compute RMS energy (normalized to 0-1 range, max int16 = 32768)
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
        // Accumulate audio even during detection phase (to capture onset)
        for (let i = 0; i < frame.length; i++) {
          this.speechBuffer.push(frame[i]!);
        }
        if (this.speechFrames >= this.speechStartFrameThreshold) {
          this.isSpeaking = true;
          this.silenceFrames = 0;
          this.onSpeechStartCb?.();
        }
      } else {
        // Reset detection counter; discard accumulated pre-speech audio
        this.speechFrames = 0;
        this.speechBuffer.length = 0;
      }
    } else {
      // Currently speaking — accumulate audio
      for (let i = 0; i < frame.length; i++) {
        this.speechBuffer.push(frame[i]!);
      }

      if (isSpeechFrame) {
        this.silenceFrames = 0;
      } else {
        this.silenceFrames++;
        if (this.silenceFrames >= this.silenceFrameThreshold) {
          // Speech ended
          this.isSpeaking = false;
          this.speechFrames = 0;
          this.silenceFrames = 0;
          this.onSpeechEndCb?.();
          void this.processUtterance();
        }
      }

      // Safety: cap buffer to prevent memory runaway
      if (this.speechBuffer.length > MAX_UTTERANCE_SAMPLES_8K) {
        this.isSpeaking = false;
        this.speechFrames = 0;
        this.silenceFrames = 0;
        this.onSpeechEndCb?.();
        void this.processUtterance();
      }
    }
  }

  /** Transcode accumulated speech buffer and send to Whisper MLX for transcription. */
  private async processUtterance(): Promise<void> {
    if (this.transcribing) return;

    // Grab the accumulated speech and clear the buffer
    const pcm8k = new Int16Array(this.speechBuffer);
    this.speechBuffer.length = 0;

    // Check minimum speech duration (250 ms at 8 kHz = 2000 samples)
    const minSamples = (MIN_SPEECH_MS / 1000) * 8000;
    if (pcm8k.length < minSamples) {
      return;
    }

    this.transcribing = true;

    try {
      // Emit partial "transcribing..." indicator
      this.onPartialCb?.("[transcribing...]");

      // Resample 8 kHz -> 16 kHz
      const pcm16k = resample8to16(pcm8k);

      // Write WAV to temp file
      const wav = pcmToWav(pcm16k);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-mlx-"));
      const wavPath = path.join(tmpDir, "utterance.wav");
      await fs.writeFile(wavPath, wav);

      // Run transcription
      const text = await this.worker.transcribe(wavPath);

      // Clean up temp dir (worker already removes the file, this removes the dir)
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

      if (text) {
        console.log(`[whisper-mlx] Transcript: ${text}`);
        this.onTranscriptCb?.(text);
        if (this.waitResolve) {
          if (this.waitTimer) clearTimeout(this.waitTimer);
          this.waitResolve(text);
          this.waitResolve = null;
          this.waitReject = null;
          this.waitTimer = null;
        }
      }
    } catch (err) {
      console.error(`[whisper-mlx] Transcription error:`, err);
    } finally {
      this.transcribing = false;
    }
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
    this.audioBuffer.length = 0;
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

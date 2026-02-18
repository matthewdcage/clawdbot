/**
 * Generic STT (Speech-to-Text) Provider Interfaces
 *
 * Shared contract for all STT providers (OpenAI Realtime, Whisper MLX, etc.).
 * Providers accept streaming mu-law audio, perform VAD, and emit transcripts.
 */

/**
 * A single transcription session that accepts streaming audio and
 * fires callbacks for speech events and transcript results.
 */
export interface STTSession {
  /** Connect to the transcription service (or initialize local engine). */
  connect(): Promise<void>;
  /** Send mu-law audio data (8 kHz mono, G.711 µ-law). */
  sendAudio(audio: Buffer): void;
  /** Block until the next complete transcript is ready. */
  waitForTranscript(timeoutMs?: number): Promise<string>;
  /** Register callback for incremental partial transcripts. */
  onPartial(callback: (partial: string) => void): void;
  /** Register callback for final (complete) transcripts. */
  onTranscript(callback: (transcript: string) => void): void;
  /** Register callback when VAD detects speech start. */
  onSpeechStart(callback: () => void): void;
  /** Register callback when VAD detects speech end. */
  onSpeechEnd(callback: () => void): void;
  /** Tear down the session and release resources. */
  close(): void;
  /** Whether the session is active and ready to receive audio. */
  isConnected(): boolean;
}

/**
 * Factory that creates per-call STT sessions.
 * One provider instance is shared across the runtime; each call gets its own session.
 */
export interface STTProvider {
  /** Human-readable provider name (e.g. "openai-realtime", "whisper-mlx"). */
  readonly name: string;
  /** Configured silence duration (ms) before VAD considers speech ended. */
  readonly silenceDurationMs: number;
  /** VAD sensitivity threshold (0–1). Higher = less sensitive. */
  readonly vadThreshold: number;
  /** Create a new transcription session for a single call. */
  createSession(): STTSession;
}

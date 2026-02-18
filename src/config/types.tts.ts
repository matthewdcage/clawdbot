export type TtsProvider = "elevenlabs" | "openai" | "edge" | "custom";

export type TtsMode = "final" | "all";

export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";

export type TtsModelOverrideConfig = {
  /** Enable model-provided overrides for TTS. */
  enabled?: boolean;
  /** Allow model-provided TTS text blocks. */
  allowText?: boolean;
  /** Allow model-provided provider override. */
  allowProvider?: boolean;
  /** Allow model-provided voice/voiceId override. */
  allowVoice?: boolean;
  /** Allow model-provided modelId override. */
  allowModelId?: boolean;
  /** Allow model-provided voice settings override. */
  allowVoiceSettings?: boolean;
  /** Allow model-provided normalization or language overrides. */
  allowNormalization?: boolean;
  /** Allow model-provided seed override. */
  allowSeed?: boolean;
};

export type TtsConfig = {
  /** Auto-TTS mode (preferred). */
  auto?: TtsAutoMode;
  /** Legacy: enable auto-TTS when `auto` is not set. */
  enabled?: boolean;
  /** Apply TTS to final replies only or to all replies (tool/block/final). */
  mode?: TtsMode;
  /** Primary TTS provider (fallbacks are automatic). */
  provider?: TtsProvider;
  /** Optional model override for TTS auto-summary (provider/model or alias). */
  summaryModel?: string;
  /** Allow the model to override TTS parameters. */
  modelOverrides?: TtsModelOverrideConfig;
  /** ElevenLabs configuration. */
  elevenlabs?: {
    apiKey?: string;
    baseUrl?: string;
    voiceId?: string;
    modelId?: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
      speed?: number;
    };
  };
  /** OpenAI configuration. */
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  /** Microsoft Edge (node-edge-tts) configuration. */
  edge?: {
    /** Explicitly allow Edge TTS usage (no API key required). */
    enabled?: boolean;
    voice?: string;
    lang?: string;
    outputFormat?: string;
    pitch?: string;
    rate?: string;
    volume?: string;
    saveSubtitles?: boolean;
    proxy?: string;
    timeoutMs?: number;
  };
  /** Custom/Generic TTS API configuration (e.g. Qwen3 Voice Studio). */
  custom?: {
    /** Base URL of the custom TTS API (default: http://localhost:8880). */
    baseUrl?: string;
    /** Optional API key (sent as X-API-Key header when set). */
    apiKey?: string;
    /**
     * Voice name to use for synthesis.
     * Preset voices use /v1/tts; custom/cloned voices use /v1/tts/clone.
     */
    voice?: string;
    /**
     * Emotion preset key (e.g. "empathetic", "happy", "calm").
     * Resolved server-side to an instruct string via /v1/emotions.
     */
    emotion?: string;
    /** Freeform style instruction (overrides emotion when both are set). */
    instruct?: string;
    /** Language code (default: "auto"). */
    language?: string;
    /** Speech speed multiplier (0.5-2.0, default: 1.0). */
    speed?: number;
    /** Generation temperature (0.1-1.5, default: 0.7). */
    temperature?: number;
    /** Enable streaming mode for lower time-to-first-audio (default: true). */
    streaming?: boolean;
    /**
     * Voice mode: "preset" uses /v1/tts, "clone" uses /v1/tts/clone.
     * Default: auto-detect (clone if voice is non-empty and not a known preset).
     */
    voiceMode?: "preset" | "clone";
    /** API request timeout override (ms). */
    timeoutMs?: number;
  };
  /** Optional path for local TTS user preferences JSON. */
  prefsPath?: string;
  /** Hard cap for text sent to TTS (chars). */
  maxTextLength?: number;
  /** API request timeout (ms). */
  timeoutMs?: number;
};

import {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "openclaw/plugin-sdk";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

/**
 * E.164 phone number format: +[country code][number]
 * Examples use 555 prefix (reserved for fictional numbers)
 */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

/**
 * Controls how inbound calls are handled:
 * - "disabled": Block all inbound calls (outbound only)
 * - "allowlist": Only accept calls from numbers in allowFrom
 * - "pairing": Unknown callers can request pairing (future)
 * - "open": Accept all inbound calls (dangerous!)
 */
export const InboundPolicySchema = z.enum(["disabled", "allowlist", "pairing", "open"]);
export type InboundPolicy = z.infer<typeof InboundPolicySchema>;

// -----------------------------------------------------------------------------
// Provider-Specific Configuration
// -----------------------------------------------------------------------------

export const TelnyxConfigSchema = z
  .object({
    /** Telnyx API v2 key */
    apiKey: z.string().min(1).optional(),
    /** Telnyx connection ID (from Call Control app) */
    connectionId: z.string().min(1).optional(),
    /** Public key for webhook signature verification */
    publicKey: z.string().min(1).optional(),
  })
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

export const TwilioConfigSchema = z
  .object({
    /** Twilio Account SID */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;

export const PlivoConfigSchema = z
  .object({
    /** Plivo Auth ID (starts with MA/SA) */
    authId: z.string().min(1).optional(),
    /** Plivo Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type PlivoConfig = z.infer<typeof PlivoConfigSchema>;

export const ThreeCXConfigSchema = z
  .object({
    /** SIP registrar host (e.g. 1442.3cx.cloud) */
    server: z.string().min(1).optional(),
    /** SIP extension number (e.g. 17311) — used in From/To URI */
    extension: z.string().min(1).optional(),
    /** SIP authentication ID — if different from extension (e.g. 3CX AuthID) */
    authId: z.string().min(1).optional(),
    /** SIP authentication password */
    password: z.string().min(1).optional(),
    /** SIP domain (e.g. 1442.3cx.cloud) */
    domain: z.string().min(1).optional(),
    /** drachtio-server TCP host (default: 127.0.0.1) */
    drachtioHost: z.string().default("127.0.0.1"),
    /** drachtio-server TCP port (default: 9022) */
    drachtioPort: z.number().default(9022),
    /** drachtio-server shared secret (default: cymru) */
    drachtioSecret: z.string().default("cymru"),
    /** Minimum RTP port for media (default: 21000) */
    rtpPortMin: z.number().default(21000),
    /** Maximum RTP port for media (default: 21100) */
    rtpPortMax: z.number().default(21100),
    /** Public IP for SIP Contact header (NAT traversal). Auto-detected if empty. */
    externalIp: z.string().min(1).optional(),
    /** FreeSWITCH ESL host (default: 127.0.0.1) */
    freeswitchHost: z.string().default("127.0.0.1"),
    /** FreeSWITCH ESL port (default: 8122) */
    freeswitchPort: z.number().default(8122),
    /** FreeSWITCH ESL secret */
    freeswitchSecret: z.string().min(1).optional(),
    /** Audio fork WebSocket port (default: 3001) */
    audioForkPort: z.number().default(3001),
  })
  .strict();
export type ThreeCXConfig = z.infer<typeof ThreeCXConfigSchema>;

// -----------------------------------------------------------------------------
// STT/TTS Configuration
// -----------------------------------------------------------------------------

/**
 * All supported STT provider identifiers.
 * - "whisper-mlx": Local Whisper on Apple Silicon via MLX (no API key, private)
 * - "openai-realtime": OpenAI Realtime WebSocket API (lowest latency, streaming)
 * - "openai": OpenAI standard Whisper API (batch, simple, requires OPENAI_API_KEY)
 */
export const SttProviderEnum = z.enum(["whisper-mlx", "openai-realtime", "openai"]);
export type SttProviderName = z.infer<typeof SttProviderEnum>;

export const SttConfigSchema = z
  .object({
    /**
     * Primary STT provider.
     * - "whisper-mlx": Local Whisper via Apple Silicon MLX (no API key needed)
     * - "openai-realtime": OpenAI Realtime WebSocket API (low latency streaming)
     * - "openai": OpenAI standard Whisper API (requires OPENAI_API_KEY)
     */
    provider: SttProviderEnum.default("whisper-mlx"),
    /**
     * Model name for the primary provider.
     * - whisper-mlx: HuggingFace repo (e.g. "mlx-community/whisper-large-v3-turbo")
     * - openai-realtime: Realtime model (e.g. "gpt-4o-transcribe")
     * - openai: API model name (e.g. "whisper-1")
     */
    model: z.string().min(1).default("mlx-community/whisper-large-v3-turbo"),
    /**
     * Fallback STT provider when the primary is unavailable.
     * - "openai-realtime": Fall back to OpenAI Realtime API
     * - "openai": Fall back to OpenAI standard Whisper API
     * - "whisper-mlx": Fall back to local MLX Whisper
     * - "none": No fallback; fail if primary is unavailable
     */
    fallback: z
      .enum(["openai-realtime", "openai", "whisper-mlx", "none"])
      .default("openai-realtime"),
    /** Fallback model name (default: gpt-4o-transcribe for openai-realtime) */
    fallbackModel: z.string().min(1).default("gpt-4o-transcribe"),
  })
  .strict()
  .default({
    provider: "whisper-mlx",
    model: "mlx-community/whisper-large-v3-turbo",
    fallback: "openai-realtime",
    fallbackModel: "gpt-4o-transcribe",
  });
export type SttConfig = z.infer<typeof SttConfigSchema>;

export { TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema };
export type VoiceCallTtsConfig = z.infer<typeof TtsConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const VoiceCallServeConfigSchema = z
  .object({
    /** Port to listen on */
    port: z.number().int().positive().default(3334),
    /** Bind address */
    bind: z.string().default("127.0.0.1"),
    /** Webhook path */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ port: 3334, bind: "127.0.0.1", path: "/voice/webhook" });
export type VoiceCallServeConfig = z.infer<typeof VoiceCallServeConfigSchema>;

export const VoiceCallTailscaleConfigSchema = z
  .object({
    /**
     * Tailscale exposure mode:
     * - "off": No Tailscale exposure
     * - "serve": Tailscale serve (private to tailnet)
     * - "funnel": Tailscale funnel (public HTTPS)
     */
    mode: z.enum(["off", "serve", "funnel"]).default("off"),
    /** Path for Tailscale serve/funnel (should usually match serve.path) */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ mode: "off", path: "/voice/webhook" });
export type VoiceCallTailscaleConfig = z.infer<typeof VoiceCallTailscaleConfigSchema>;

// -----------------------------------------------------------------------------
// Tunnel Configuration (unified ngrok/tailscale)
// -----------------------------------------------------------------------------

export const VoiceCallTunnelConfigSchema = z
  .object({
    /**
     * Tunnel provider:
     * - "none": No tunnel (use publicUrl if set, or manual setup)
     * - "ngrok": Use ngrok for public HTTPS tunnel
     * - "tailscale-serve": Tailscale serve (private to tailnet)
     * - "tailscale-funnel": Tailscale funnel (public HTTPS)
     */
    provider: z.enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"]).default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /**
     * Allow ngrok free tier compatibility mode.
     * When true, forwarded headers may be trusted for loopback requests
     * to reconstruct the public ngrok URL used for signing.
     *
     * IMPORTANT: This does NOT bypass signature verification.
     */
    allowNgrokFreeTierLoopbackBypass: z.boolean().default(false),
  })
  .strict()
  .default({ provider: "none", allowNgrokFreeTierLoopbackBypass: false });
export type VoiceCallTunnelConfig = z.infer<typeof VoiceCallTunnelConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Security Configuration
// -----------------------------------------------------------------------------

export const VoiceCallWebhookSecurityConfigSchema = z
  .object({
    /**
     * Allowed hostnames for webhook URL reconstruction.
     * Only these hosts are accepted from forwarding headers.
     */
    allowedHosts: z.array(z.string().min(1)).default([]),
    /**
     * Trust X-Forwarded-* headers without a hostname allowlist.
     * WARNING: Only enable if you trust your proxy configuration.
     */
    trustForwardingHeaders: z.boolean().default(false),
    /**
     * Trusted proxy IP addresses. Forwarded headers are only trusted when
     * the remote IP matches one of these addresses.
     */
    trustedProxyIPs: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({ allowedHosts: [], trustForwardingHeaders: false, trustedProxyIPs: [] });
export type WebhookSecurityConfig = z.infer<typeof VoiceCallWebhookSecurityConfigSchema>;

// -----------------------------------------------------------------------------
// Outbound Call Configuration
// -----------------------------------------------------------------------------

/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
export const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

export const OutboundConfigSchema = z
  .object({
    /** Default call mode for outbound calls */
    defaultMode: CallModeSchema.default("notify"),
    /** Seconds to wait after TTS before auto-hangup in notify mode */
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ defaultMode: "notify", notifyHangupDelaySec: 3 });
export type OutboundConfig = z.infer<typeof OutboundConfigSchema>;

// -----------------------------------------------------------------------------
// Streaming Configuration (OpenAI Realtime STT)
// -----------------------------------------------------------------------------

export const VoiceCallStreamingConfigSchema = z
  .object({
    /** Enable real-time audio streaming (requires WebSocket support) */
    enabled: z.boolean().default(false),
    /**
     * Primary STT provider for real-time transcription.
     * - "whisper-mlx": Local Whisper on Apple Silicon (no API key, ~1s latency per utterance)
     * - "openai-realtime": OpenAI Realtime WebSocket API (lowest latency, streaming)
     * - "openai": OpenAI standard Whisper API (batch per utterance, requires API key)
     */
    sttProvider: SttProviderEnum.default("whisper-mlx"),
    /**
     * Fallback STT provider when the primary is unavailable or fails.
     * - "openai-realtime": Fall back to OpenAI Realtime WebSocket API
     * - "openai": Fall back to OpenAI standard Whisper API
     * - "whisper-mlx": Fall back to local MLX Whisper
     * - "none": No fallback
     */
    sttFallback: z
      .enum(["openai-realtime", "openai", "whisper-mlx", "none"])
      .default("openai-realtime"),
    /** OpenAI API key for Realtime API (uses OPENAI_API_KEY env if not set) */
    openaiApiKey: z.string().min(1).optional(),
    /** OpenAI transcription model (default: gpt-4o-transcribe) */
    sttModel: z.string().min(1).default("gpt-4o-transcribe"),
    /**
     * HuggingFace model repo for Whisper MLX local transcription.
     * Examples: "mlx-community/whisper-large-v3-turbo", "mlx-community/whisper-small"
     */
    whisperMlxModel: z.string().min(1).default("mlx-community/whisper-large-v3-turbo"),
    /** Python executable path for mlx_whisper (default: auto-detect "python3") */
    whisperMlxPython: z.string().min(1).optional(),
    /** Language hint for Whisper MLX (e.g. "en"). Omit for auto-detect. */
    whisperMlxLanguage: z.string().min(1).optional(),
    /** VAD silence duration in ms before considering speech ended */
    silenceDurationMs: z.number().int().positive().default(800),
    /** VAD threshold 0-1 (higher = less sensitive) */
    vadThreshold: z.number().min(0).max(1).default(0.5),
    /** WebSocket path for media stream connections */
    streamPath: z.string().min(1).default("/voice/stream"),
    /** Enable barge-in (user can interrupt agent TTS). Default: true */
    bargeInEnabled: z.boolean().default(true),
    /** Minimum speech duration (ms) before triggering barge-in to avoid false positives */
    bargeInMinDurationMs: z.number().int().min(0).max(2000).default(300),
    /**
     * Close unauthenticated media stream sockets if no valid `start` frame arrives in time.
     * Protects against pre-auth idle connection hold attacks.
     */
    preStartTimeoutMs: z.number().int().positive().default(5000),
    /** Maximum number of concurrently pending (pre-start) media stream sockets. */
    maxPendingConnections: z.number().int().positive().default(32),
    /** Maximum pending media stream sockets per source IP. */
    maxPendingConnectionsPerIp: z.number().int().positive().default(4),
    /** Hard cap for all open media stream sockets (pending + active). */
    maxConnections: z.number().int().positive().default(128),
  })
  .strict()
  .default({
    enabled: false,
    sttProvider: "whisper-mlx",
    sttFallback: "openai-realtime",
    sttModel: "gpt-4o-transcribe",
    whisperMlxModel: "mlx-community/whisper-large-v3-turbo",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
    streamPath: "/voice/stream",
    bargeInEnabled: true,
    bargeInMinDurationMs: 300,
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  });
export type VoiceCallStreamingConfig = z.infer<typeof VoiceCallStreamingConfigSchema>;

// -----------------------------------------------------------------------------
// Main Voice Call Configuration
// -----------------------------------------------------------------------------

export const VoiceCallConfigSchema = z
  .object({
    /** Enable voice call functionality */
    enabled: z.boolean().default(false),

    /** Active provider (telnyx, twilio, plivo, threecx, or mock) */
    provider: z.enum(["telnyx", "twilio", "plivo", "threecx", "mock"]).optional(),

    /** Telnyx-specific configuration */
    telnyx: TelnyxConfigSchema.optional(),

    /** Twilio-specific configuration */
    twilio: TwilioConfigSchema.optional(),

    /** Plivo-specific configuration */
    plivo: PlivoConfigSchema.optional(),

    /** 3CX PBX configuration (SIP over WebSocket) */
    threecx: ThreeCXConfigSchema.optional(),

    /** Phone number to call from (E.164) */
    fromNumber: E164Schema.optional(),

    /** Default phone number to call (E.164) */
    toNumber: E164Schema.optional(),

    /** Inbound call policy */
    inboundPolicy: InboundPolicySchema.default("disabled"),

    /** Allowlist of phone numbers for inbound calls (E.164) */
    allowFrom: z.array(E164Schema).default([]),

    /** Greeting message for inbound calls */
    inboundGreeting: z.string().optional(),

    /** Outbound call configuration */
    outbound: OutboundConfigSchema,

    /** Maximum call duration in seconds */
    maxDurationSeconds: z.number().int().positive().default(3600),

    /**
     * Maximum age of a call in seconds before it is automatically reaped.
     * Catches calls stuck in unexpected states (e.g., notify-mode calls that
     * never receive a terminal webhook). Set to 0 to disable.
     * Default: 0 (disabled). Recommended: 120-300 for production.
     */
    staleCallReaperSeconds: z.number().int().nonnegative().default(0),

    /** Silence timeout for end-of-speech detection (ms) */
    silenceTimeoutMs: z.number().int().positive().default(800),

    /** Timeout for user transcript (ms) */
    transcriptTimeoutMs: z.number().int().positive().default(180000),

    /** Ring timeout for outbound calls (ms) */
    ringTimeoutMs: z.number().int().positive().default(30000),

    /** Maximum concurrent calls */
    maxConcurrentCalls: z.number().int().positive().default(1),

    /** Webhook server configuration */
    serve: VoiceCallServeConfigSchema,

    /** Tailscale exposure configuration (legacy, prefer tunnel config) */
    tailscale: VoiceCallTailscaleConfigSchema,

    /** Tunnel configuration (unified ngrok/tailscale) */
    tunnel: VoiceCallTunnelConfigSchema,

    /** Webhook signature reconstruction and proxy trust configuration */
    webhookSecurity: VoiceCallWebhookSecurityConfigSchema,

    /** Real-time audio streaming configuration */
    streaming: VoiceCallStreamingConfigSchema,

    /** Public webhook URL override (if set, bypasses tunnel auto-detection) */
    publicUrl: z.string().url().optional(),

    /** Skip webhook signature verification (development only, NOT for production) */
    skipSignatureVerification: z.boolean().default(false),

    /** STT configuration */
    stt: SttConfigSchema,

    /** TTS override (deep-merges with core messages.tts) */
    tts: TtsConfigSchema,

    /** Store path for call logs */
    store: z.string().optional(),

    /** Model for generating voice responses (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o") */
    responseModel: z.string().default("openai/gpt-4o-mini"),

    /** System prompt for voice responses */
    responseSystemPrompt: z.string().optional(),

    /** Timeout for response generation in ms (default 30s) */
    responseTimeoutMs: z.number().int().positive().default(30000),

    /** Maximum tool iterations per voice turn (lower than default to avoid long hangs).
     *  0 = use the agent default. */
    maxToolIterations: z.number().int().nonnegative().default(5),
  })
  .strict();

export type VoiceCallConfig = z.infer<typeof VoiceCallConfigSchema>;

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

/**
 * Resolves the configuration by merging environment variables into missing fields.
 * Returns a new configuration object with environment variables applied.
 */
export function resolveVoiceCallConfig(config: VoiceCallConfig): VoiceCallConfig {
  const resolved = JSON.parse(JSON.stringify(config)) as VoiceCallConfig;

  // Telnyx
  if (resolved.provider === "telnyx") {
    resolved.telnyx = resolved.telnyx ?? {};
    resolved.telnyx.apiKey = resolved.telnyx.apiKey ?? process.env.TELNYX_API_KEY;
    resolved.telnyx.connectionId = resolved.telnyx.connectionId ?? process.env.TELNYX_CONNECTION_ID;
    resolved.telnyx.publicKey = resolved.telnyx.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
  }

  // Twilio
  if (resolved.provider === "twilio") {
    resolved.twilio = resolved.twilio ?? {};
    resolved.twilio.accountSid = resolved.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    resolved.twilio.authToken = resolved.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  }

  // Plivo
  if (resolved.provider === "plivo") {
    resolved.plivo = resolved.plivo ?? {};
    resolved.plivo.authId = resolved.plivo.authId ?? process.env.PLIVO_AUTH_ID;
    resolved.plivo.authToken = resolved.plivo.authToken ?? process.env.PLIVO_AUTH_TOKEN;
  }

  // 3CX (SIP over WebSocket -- no webhooks needed)
  if (resolved.provider === "threecx") {
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "config.ts:resolveVoiceCallConfig:threecx:before",
        message: "ThreeCX config BEFORE resolution",
        data: {
          hasThreecx: !!resolved.threecx,
          rtpPortMin: resolved.threecx?.rtpPortMin,
          rtpPortMax: resolved.threecx?.rtpPortMax,
        },
        hypothesisId: "CONFIG",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const cx = resolved.threecx ?? {
      drachtioHost: "127.0.0.1",
      drachtioPort: 9022,
      drachtioSecret: "cymru",
      rtpPortMin: 21000,
      rtpPortMax: 21100,
      freeswitchHost: "127.0.0.1",
      freeswitchPort: 8122,
      audioForkPort: 3001,
    };
    cx.server = cx.server ?? process.env.THREECX_SERVER;
    cx.extension = cx.extension ?? process.env.THREECX_EXTENSION;
    cx.authId = cx.authId ?? process.env.THREECX_AUTH_ID;
    cx.password = cx.password ?? process.env.THREECX_PASSWORD;
    cx.domain = cx.domain ?? process.env.THREECX_DOMAIN;
    cx.externalIp = cx.externalIp ?? process.env.THREECX_EXTERNAL_IP;
    // Ensure RTP port config is preserved from user config (not overwritten by defaults)
    cx.rtpPortMin = cx.rtpPortMin ?? 21000;
    cx.rtpPortMax = cx.rtpPortMax ?? 21100;
    resolved.threecx = cx;
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "config.ts:resolveVoiceCallConfig:threecx:after",
        message: "ThreeCX config AFTER resolution",
        data: { rtpPortMin: cx.rtpPortMin, rtpPortMax: cx.rtpPortMax },
        hypothesisId: "CONFIG",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }

  // Tunnel Config
  resolved.tunnel = resolved.tunnel ?? {
    provider: "none",
    allowNgrokFreeTierLoopbackBypass: false,
  };
  resolved.tunnel.allowNgrokFreeTierLoopbackBypass =
    resolved.tunnel.allowNgrokFreeTierLoopbackBypass ?? false;
  resolved.tunnel.ngrokAuthToken = resolved.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN;
  resolved.tunnel.ngrokDomain = resolved.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN;

  // Webhook Security Config
  resolved.webhookSecurity = resolved.webhookSecurity ?? {
    allowedHosts: [],
    trustForwardingHeaders: false,
    trustedProxyIPs: [],
  };
  resolved.webhookSecurity.allowedHosts = resolved.webhookSecurity.allowedHosts ?? [];
  resolved.webhookSecurity.trustForwardingHeaders =
    resolved.webhookSecurity.trustForwardingHeaders ?? false;
  resolved.webhookSecurity.trustedProxyIPs = resolved.webhookSecurity.trustedProxyIPs ?? [];

  return resolved;
}

/**
 * Validate that the configuration has all required fields for the selected provider.
 */
export function validateProviderConfig(config: VoiceCallConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.provider) {
    errors.push("plugins.entries.voice-call.config.provider is required");
  }

  // 3CX uses SIP extensions instead of E.164 numbers; mock doesn't need fromNumber
  if (!config.fromNumber && config.provider !== "mock" && config.provider !== "threecx") {
    errors.push("plugins.entries.voice-call.config.fromNumber is required");
  }

  if (config.provider === "telnyx") {
    if (!config.telnyx?.apiKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
      );
    }
    if (!config.telnyx?.connectionId) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)",
      );
    }
    if (!config.skipSignatureVerification && !config.telnyx?.publicKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
      );
    }
  }

  if (config.provider === "twilio") {
    if (!config.twilio?.accountSid) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );
    }
    if (!config.twilio?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    }
  }

  if (config.provider === "plivo") {
    if (!config.plivo?.authId) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
      );
    }
    if (!config.plivo?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authToken is required (or set PLIVO_AUTH_TOKEN env)",
      );
    }
  }

  if (config.provider === "threecx") {
    if (!config.threecx?.server) {
      errors.push(
        "plugins.entries.voice-call.config.threecx.server is required (or set THREECX_SERVER env)",
      );
    }
    if (!config.threecx?.extension) {
      errors.push(
        "plugins.entries.voice-call.config.threecx.extension is required (or set THREECX_EXTENSION env)",
      );
    }
    if (!config.threecx?.password) {
      errors.push(
        "plugins.entries.voice-call.config.threecx.password is required (or set THREECX_PASSWORD env)",
      );
    }
    if (!config.threecx?.domain) {
      errors.push(
        "plugins.entries.voice-call.config.threecx.domain is required (or set THREECX_DOMAIN env)",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

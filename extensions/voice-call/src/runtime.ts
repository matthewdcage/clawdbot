import type { VoiceCallConfig } from "./config.js";
import { resolveVoiceCallConfig, validateProviderConfig, type SttProviderName } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { loadCoreAgentDeps } from "./core-bridge.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import type { STTProvider } from "./providers/stt-base.js";
import { TelnyxProvider } from "./providers/telnyx.js";
import { ThreeCXProvider } from "./providers/threecx.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import type { NormalizedEvent } from "./types.js";
import {
  cleanupTailscaleExposure,
  setupTailscaleExposure,
  VoiceCallWebhookServer,
} from "./webhook.js";

export type VoiceCallRuntime = {
  config: VoiceCallConfig;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

function isLoopbackBind(bind: string | undefined): boolean {
  if (!bind) {
    return false;
  }
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function resolveProvider(config: VoiceCallConfig): VoiceCallProvider {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel?.provider === "ngrok" &&
    isLoopbackBind(config.serve?.bind) &&
    (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);

  switch (config.provider) {
    case "telnyx":
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey,
        },
        {
          skipVerification: config.skipSignatureVerification,
        },
      );
    case "twilio":
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : undefined,
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "plivo":
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "mock":
      return new MockProvider();
    case "threecx": {
      if (!config.threecx) {
        throw new Error("3CX configuration is required");
      }
      return new ThreeCXProvider(config.threecx);
    }
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}

export async function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
}): Promise<VoiceCallRuntime> {
  const { config: rawConfig, coreConfig, ttsRuntime, logger } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = resolveVoiceCallConfig(rawConfig);

  if (!config.enabled) {
    throw new Error("Voice call disabled. Enable the plugin entry in config.");
  }

  if (config.skipSignatureVerification) {
    log.warn(
      "[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production.",
    );
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }

  const provider = resolveProvider(config);
  const manager = new CallManager(config);
  const webhookServer = new VoiceCallWebhookServer(config, manager, provider, coreConfig);

  const localUrl = await webhookServer.start();

  // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
  let publicUrl: string | null = config.publicUrl ?? null;
  let tunnelResult: TunnelResult | null = null;

  if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
    try {
      tunnelResult = await startTunnel({
        provider: config.tunnel.provider,
        port: config.serve.port,
        path: config.serve.path,
        ngrokAuthToken: config.tunnel.ngrokAuthToken,
        ngrokDomain: config.tunnel.ngrokDomain,
      });
      publicUrl = tunnelResult?.publicUrl ?? null;
    } catch (err) {
      log.error(
        `[voice-call] Tunnel setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!publicUrl && config.tailscale?.mode !== "off") {
    publicUrl = await setupTailscaleExposure(config);
  }

  const webhookUrl = publicUrl ?? localUrl;

  if (publicUrl && provider.name === "twilio") {
    (provider as TwilioProvider).setPublicUrl(publicUrl);
  }

  if (provider.name === "twilio" && config.streaming?.enabled) {
    const twilioProvider = provider as TwilioProvider;
    if (ttsRuntime?.textToSpeechTelephony) {
      try {
        const ttsProvider = createTelephonyTtsProvider({
          coreConfig,
          ttsOverride: config.tts,
          runtime: ttsRuntime,
        });
        twilioProvider.setTTSProvider(ttsProvider);
        log.info("[voice-call] Telephony TTS provider configured");
      } catch (err) {
        log.warn(
          `[voice-call] Failed to initialize telephony TTS: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
    }

    const mediaHandler = webhookServer.getMediaStreamHandler();
    if (mediaHandler) {
      twilioProvider.setMediaStreamHandler(mediaHandler);
      log.info("[voice-call] Media stream handler wired to provider");
    }
  }

  manager.initialize(provider, webhookUrl);

  // For ThreeCX: connect via drachtio-srf (SIP/UDP) and wire events to CallManager.
  // Unlike webhook-based providers, ThreeCX events come from SIP messages and
  // must be forwarded to the manager explicitly.
  if (provider.name === "threecx") {
    const threecxProvider = provider as ThreeCXProvider;

    // Bridge SIP events -> CallManager + auto-start STT on answer.
    // CallManager assigns its own callId (UUID) which differs from the
    // ThreeCX-internal UUID. We capture the original callId before
    // processEvent mutates it, then register an alias so all provider
    // methods (startListening, playTts, hangupCall, etc.) can find
    // the SIP session regardless of which callId is used.
    threecxProvider.addEventListener(async (event) => {
      try {
        const originalCallId = event.callId;
        manager.processEvent(event);

        // Register alias when CallManager assigned a different callId
        if (event.callId !== originalCallId) {
          threecxProvider.registerCallIdAlias(event.callId, originalCallId);
        }

        // On answer: speak initial greeting first, THEN start STT.
        // The greeting must finish before STT begins; otherwise the
        // greeting audio leaks back through the microphone and the
        // STT detects it as user speech, triggering barge-in and
        // cutting off the greeting mid-sentence.
        if (event.type === "call.answered") {
          try {
            await manager.speakInitialMessage(event.providerCallId ?? event.callId);
          } catch (err) {
            log.warn(
              `[voice-call] Initial greeting failed (will still start STT): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          threecxProvider
            .startListening({
              callId: event.callId,
              providerCallId: event.providerCallId ?? event.callId,
            })
            .catch((err) => {
              log.error(
                `[voice-call] Failed to auto-start listening: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      } catch (err) {
        log.error(
          `[voice-call] Error processing 3CX event ${event.type}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });

    try {
      await threecxProvider.connect();
      log.info("[voice-call] ThreeCX SIP registration successful");

      // Debug: log port pool status after initialization
      const portStatus = threecxProvider.portPoolStatus;
      log.info(
        `[voice-call] Port pool initialized: range=${config.threecx?.rtpPortMin ?? 21000}-${config.threecx?.rtpPortMax ?? 21100}, ` +
          `available=${portStatus.available}, active=${portStatus.active}`,
      );
    } catch (err) {
      log.error(
        `[voice-call] ThreeCX SIP registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    // Wire TTS provider for ThreeCX (mirrors the Twilio TTS setup above)
    if (ttsRuntime?.textToSpeechTelephony) {
      try {
        const ttsProvider = createTelephonyTtsProvider({
          coreConfig,
          ttsOverride: config.tts,
          runtime: ttsRuntime,
        });
        threecxProvider.setTTSProvider(ttsProvider);
        log.info("[voice-call] ThreeCX TTS provider configured");
      } catch (err) {
        log.warn(
          `[voice-call] ThreeCX TTS init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      log.warn("[voice-call] ThreeCX TTS unavailable; voice responses will be silent");
    }

    // Wire STT provider for ThreeCX — try primary, then fallback.
    const primaryStt = config.streaming?.sttProvider ?? config.stt?.provider ?? "whisper-mlx";
    const fallbackStt = config.streaming?.sttFallback ?? config.stt?.fallback ?? "openai-realtime";

    let sttProvider = await createSTTProvider(primaryStt, config, log);
    if (!sttProvider && fallbackStt !== "none") {
      log.warn(
        `[voice-call] Primary STT "${primaryStt}" unavailable, trying fallback "${fallbackStt}"`,
      );
      sttProvider = await createSTTProvider(fallbackStt as SttProviderName, config, log);
    }

    if (sttProvider) {
      threecxProvider.setSTTProvider(sttProvider);
      log.info(
        `[voice-call] ThreeCX STT: ${sttProvider.name} (silence=${sttProvider.silenceDurationMs}ms, vad=${sttProvider.vadThreshold})`,
      );
    } else {
      log.warn("[voice-call] ThreeCX STT unavailable; no provider could be initialized");
    }

    // Wire barge-in configuration from streaming config
    threecxProvider.setBargeInConfig(
      config.streaming?.bargeInEnabled ?? true,
      config.streaming?.bargeInMinDurationMs ?? 300,
    );
    const bargeIn = config.streaming?.bargeInEnabled ?? true;
    log.info(
      `[voice-call] ThreeCX barge-in: ${bargeIn ? "enabled" : "disabled"} (debounce: ${config.streaming?.bargeInMinDurationMs ?? 300}ms)`,
    );

    // Wire conversation loop for 3CX: when user speech is detected, generate and speak response.
    // This mirrors the handleInboundResponse flow used by Twilio streaming.
    setupThreeCXConversationLoop({
      provider: threecxProvider,
      manager,
      config,
      coreConfig,
      log,
    });
  }

  const stop = async () => {
    // Disconnect ThreeCX SIP registration if active
    if (provider.name === "threecx") {
      try {
        await (provider as ThreeCXProvider).disconnect();
      } catch {
        // Best-effort cleanup
      }
    }
    if (tunnelResult) {
      await tunnelResult.stop();
    }
    await cleanupTailscaleExposure(config);
    await webhookServer.stop();
  };

  log.info("[voice-call] Runtime initialized");
  log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
  if (publicUrl) {
    log.info(`[voice-call] Public URL: ${publicUrl}`);
  }

  return {
    config,
    provider,
    manager,
    webhookServer,
    webhookUrl,
    publicUrl,
    stop,
  };
}

// ---------------------------------------------------------------------------
// STT Provider Factory
// ---------------------------------------------------------------------------

/**
 * Create an STT provider by name. Returns null if the provider can't be
 * initialized (e.g. missing API key, missing Python package).
 */
async function createSTTProvider(
  name: SttProviderName,
  config: VoiceCallConfig,
  log: Logger,
): Promise<STTProvider | null> {
  const streaming = config.streaming;
  const silenceDurationMs = streaming?.silenceDurationMs ?? 800;
  const vadThreshold = streaming?.vadThreshold ?? 0.5;

  switch (name) {
    case "whisper-mlx": {
      try {
        const { WhisperMLXSTTProvider } = await import("./providers/stt-whisper-mlx.js");
        const provider = new WhisperMLXSTTProvider({
          model: streaming?.whisperMlxModel ?? "mlx-community/whisper-large-v3-turbo",
          silenceDurationMs,
          // Whisper MLX uses local energy-based VAD with a lower default threshold
          vadThreshold: vadThreshold <= 0.1 ? vadThreshold : 0.03,
          pythonPath: streaming?.whisperMlxPython,
          language: streaming?.whisperMlxLanguage,
        });
        return provider;
      } catch (err) {
        log.warn(
          `[voice-call] whisper-mlx init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    case "openai-realtime": {
      const apiKey = streaming?.openaiApiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        log.warn("[voice-call] openai-realtime STT unavailable: no API key");
        return null;
      }
      try {
        const { OpenAIRealtimeSTTProvider } = await import("./providers/stt-openai-realtime.js");
        return new OpenAIRealtimeSTTProvider({
          apiKey,
          model: streaming?.sttModel ?? "gpt-4o-transcribe",
          silenceDurationMs,
          vadThreshold,
        });
      } catch (err) {
        log.warn(
          `[voice-call] openai-realtime STT init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    case "openai": {
      const apiKey = streaming?.openaiApiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        log.warn("[voice-call] openai STT unavailable: no API key");
        return null;
      }
      try {
        const { OpenAIBatchSTTProvider } = await import("./providers/stt-openai-batch.js");
        return new OpenAIBatchSTTProvider({
          apiKey,
          model: config.stt?.model ?? "whisper-1",
          silenceDurationMs,
          vadThreshold: vadThreshold <= 0.1 ? vadThreshold : 0.03,
        });
      } catch (err) {
        log.warn(
          `[voice-call] openai batch STT init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    default:
      log.warn(`[voice-call] Unknown STT provider: ${String(name)}`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// ThreeCX Conversation Loop
// ---------------------------------------------------------------------------

/**
 * Set up the conversation loop for 3CX calls.
 * Listens for final speech events, generates responses via the embedded agent,
 * and speaks them back to the caller via TTS.
 */
function setupThreeCXConversationLoop(params: {
  provider: ThreeCXProvider;
  manager: CallManager;
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  log: Logger;
}): void {
  const { provider, manager, config, coreConfig, log } = params;

  // Track calls that are currently generating a response to avoid overlapping responses
  const pendingResponses = new Set<string>();

  provider.addEventListener(async (event: NormalizedEvent) => {
    // Only process final speech events (user finished speaking)
    if (event.type !== "call.speech" || !event.isFinal) {
      return;
    }

    const callId = event.callId;
    const userMessage = event.transcript;

    if (!userMessage?.trim()) {
      return;
    }

    // Skip if we're already generating a response for this call
    if (pendingResponses.has(callId)) {
      log.debug(`[voice-call] Skipping overlapping response for call ${callId}`);
      return;
    }

    const call = manager.getCall(callId);
    if (!call) {
      log.warn(`[voice-call] Call ${callId} not found for conversation loop`);
      return;
    }

    log.info(`[voice-call] 3CX conversation: user said "${userMessage}"`);

    // Emit user chat event to web UI for real-time transcript display
    try {
      const deps = await loadCoreAgentDeps();
      if (deps.emitAgentEvent) {
        // Build session key from phone number (matches response-generator.ts)
        const normalizedPhone = call.from.replace(/\D/g, "");
        const sessionKey = `voice:${normalizedPhone}`;
        const runId = `voice:${callId}:${Date.now()}`;

        deps.emitAgentEvent({
          runId,
          sessionKey,
          stream: "event:chat",
          data: {
            type: "user",
            text: userMessage,
            provider: "voice",
            timestamp: Date.now(),
          },
        });
        log.debug(`[voice-call] Emitted user chat event for call ${callId}`);
      }
    } catch (err) {
      log.warn(
        `[voice-call] Failed to emit user chat event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Generate and speak response
    pendingResponses.add(callId);
    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      const result = await generateVoiceResponse({
        voiceConfig: config,
        coreConfig,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage,
      });

      if (result.error) {
        log.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (result.text) {
        log.info(`[voice-call] 3CX AI response: "${result.text}"`);

        // Emit AI response as chat event to session stream
        try {
          const deps = await loadCoreAgentDeps();
          if (deps.emitAgentEvent) {
            const runId = `voice:${callId}:${Date.now()}`;
            const normalizedPhone = call.from.replace(/\D/g, "");
            const sessionKey = `voice:${normalizedPhone}`;

            deps.emitAgentEvent({
              runId,
              sessionKey,
              stream: "event:chat",
              data: {
                type: "assistant",
                text: result.text,
                provider: "voice",
                timestamp: Date.now(),
              },
            });
            log.debug(`[voice-call] Emitted assistant chat event for call ${callId}`);
          }
        } catch (err) {
          log.warn(
            `[voice-call] Failed to emit assistant chat event: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        await manager.speak(callId, result.text);
      }
    } catch (err) {
      log.error(
        `[voice-call] 3CX conversation loop error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      pendingResponses.delete(callId);
    }
  });

  log.info("[voice-call] ThreeCX conversation loop configured");
}

import crypto from "node:crypto";
import os from "node:os";
import type { ThreeCXConfig } from "../config.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
  EndReason,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";
import type { STTProvider, STTSession } from "./stt-base.js";
import { ThreeCXMediaBridge } from "./threecx-media.js";

// Re-export for convenience
export type { ThreeCXConfig };

// drachtio-srf is CJS; use dynamic import for ESM compat
type _SrfModule = typeof import("drachtio-srf");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Active SIP session tracking */
interface SipSession {
  callId: string;
  providerCallId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  /** drachtio Dialog object */
  dialog: unknown;
  /** Audio bridge for this call */
  mediaBridge: ThreeCXMediaBridge;
  startedAt: number;
  /** AbortController for current TTS playback (barge-in cancellation) */
  ttsAbortController: AbortController | null;
}

/** Full config including drachtio + RTP fields */
interface ThreeCXFullConfig {
  server: string;
  extension: string;
  /** SIP auth username — may differ from extension (e.g. 3CX AuthID) */
  authId: string;
  password: string;
  domain: string;
  drachtioHost: string;
  drachtioPort: number;
  drachtioSecret: string;
  rtpPortMin: number;
  rtpPortMax: number;
  /** Public IP for SIP Contact header (NAT traversal). Auto-detected if empty. */
  externalIp?: string;
}

/** Event listener for call lifecycle events */
export type ThreeCXEventListener = (event: NormalizedEvent) => void;

// -----------------------------------------------------------------------------
// ThreeCXProvider
// -----------------------------------------------------------------------------

/**
 * Direct SIP/UDP Voice Call Provider (via drachtio-srf).
 *
 * Connects directly to a SIP trunk provider (e.g. CrazyTel) over UDP
 * using drachtio-server as the SIP engine. Unlike the original WebSocket
 * approach, this works with standard SIP registrars.
 *
 * Architecture:
 *   Phone -> PSTN -> SIP Trunk -> drachtio-server (Docker)
 *                                      |
 *                              drachtio-srf (Node.js)
 *                                      |
 *                              ThreeCXMediaBridge (RTP/G.711)
 *                                |           |
 *                           STT (PCM)   TTS (PCM)
 */
export class ThreeCXProvider implements VoiceCallProvider {
  readonly name = "threecx" as const;

  private readonly config: ThreeCXFullConfig;
  private srf: unknown = null;
  private SrfClass: unknown = null;
  private connected = false;
  private registered = false;
  private registerTimer: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<string, SipSession>();
  /**
   * Maps external callIds (e.g. CallManager UUIDs) to internal session callIds.
   * Needed because CallManager assigns its own UUID which differs from the
   * ThreeCX-internal UUID used as the sessions map key.
   */
  private callIdAliases = new Map<string, string>();
  private eventListeners: ThreeCXEventListener[] = [];
  /** Resolved public IP for Contact header (NAT traversal) */
  private contactHost = "localhost";
  /** TTS provider for generating mu-law audio from text */
  private ttsProvider: TelephonyTtsProvider | null = null;
  /** STT provider factory for creating transcription sessions */
  private sttProvider: STTProvider | null = null;
  /** Active STT sessions keyed by callId */
  private sttSessions = new Map<string, STTSession>();
  /** Whether barge-in (caller interrupts TTS) is enabled */
  private bargeInEnabled = true;
  /** Minimum speech duration (ms) before triggering barge-in (debounce) */
  private bargeInMinDurationMs = 300;
  /** Active barge-in debounce timers keyed by callId */
  private bargeInTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: ThreeCXConfig) {
    if (!config.server) {
      throw new Error("SIP server host is required");
    }
    if (!config.extension) {
      throw new Error("SIP extension/username is required");
    }
    if (!config.password) {
      throw new Error("SIP password is required");
    }
    if (!config.domain) {
      throw new Error("SIP domain is required");
    }

    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "threecx.ts:constructor:input",
        message: "ThreeCX constructor input config",
        data: {
          rtpPortMin: config.rtpPortMin,
          rtpPortMax: config.rtpPortMax,
          hasRtpPortMin: config.rtpPortMin !== undefined,
        },
        hypothesisId: "CONFIG",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    this.config = {
      server: config.server,
      extension: config.extension,
      authId: config.authId ?? config.extension, // default to extension if no separate authId
      password: config.password,
      domain: config.domain,
      drachtioHost: config.drachtioHost ?? "127.0.0.1",
      drachtioPort: config.drachtioPort ?? 9022,
      drachtioSecret: config.drachtioSecret ?? "cymru",
      rtpPortMin: config.rtpPortMin ?? 21000,
      rtpPortMax: config.rtpPortMax ?? 21100,
      externalIp: typeof config.externalIp === "string" ? config.externalIp : undefined,
    };
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "threecx.ts:constructor:resolved",
        message: "ThreeCX constructor RESOLVED config",
        data: { rtpPortMin: this.config.rtpPortMin, rtpPortMax: this.config.rtpPortMax },
        hypothesisId: "CONFIG",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }

  // ---------------------------------------------------------------------------
  // Event Management
  // ---------------------------------------------------------------------------

  /** Register a listener for normalized call events (used by CallManager) */
  addEventListener(listener: ThreeCXEventListener): void {
    this.eventListeners.push(listener);
  }

  removeEventListener(listener: ThreeCXEventListener): void {
    this.eventListeners = this.eventListeners.filter((l) => l !== listener);
  }

  /** Inject a TTS provider for generating spoken audio on 3CX calls. */
  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  /** Inject an STT provider factory for creating transcription sessions. */
  setSTTProvider(provider: STTProvider): void {
    this.sttProvider = provider;
  }

  /** Configure barge-in (caller interruption) settings. */
  setBargeInConfig(enabled: boolean, minDurationMs: number): void {
    this.bargeInEnabled = enabled;
    this.bargeInMinDurationMs = minDurationMs;
  }

  /**
   * Register an external callId alias so that methods like startListening,
   * playTts, hangupCall, etc. can find the SIP session when called with a
   * callId assigned by CallManager (which differs from the ThreeCX-internal
   * UUID used as the sessions map key).
   */
  registerCallIdAlias(externalCallId: string, internalCallId: string): void {
    this.callIdAliases.set(externalCallId, internalCallId);
  }

  /**
   * Look up a SIP session by any known callId.
   * Checks the primary sessions map first, then falls back to the alias map.
   */
  private findSession(callId: string): SipSession | undefined {
    const direct = this.sessions.get(callId);
    if (direct) return direct;
    const aliased = this.callIdAliases.get(callId);
    if (aliased) return this.sessions.get(aliased);
    return undefined;
  }

  private emitEvent(event: NormalizedEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[threecx] Event listener error:", err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SIP Registration via drachtio-srf
  // ---------------------------------------------------------------------------

  /**
   * Connect to drachtio-server and register with the SIP trunk provider.
   * Must be called before any call operations.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Clear any stale port allocations from previous sessions
    // (defensive reset in case disconnect() wasn't called cleanly)
    ThreeCXMediaBridge.clearAllocatedPorts();

    // Dynamic import for ESM compat (drachtio-srf is CJS)
    const SrfModule = await import("drachtio-srf");
    const Srf = (SrfModule as { default?: unknown }).default || SrfModule;
    this.SrfClass = Srf;

    // eslint-disable-next-line new-cap
    const srf = new (Srf as new () => unknown)() as Record<string, unknown>;
    this.srf = srf;

    // Connect to the local drachtio-server via TCP
    const connectFn = srf.connect as (opts: {
      host: string;
      port: number;
      secret: string;
    }) => Promise<void>;

    const onFn = srf.on as (event: string, cb: (...args: unknown[]) => void) => void;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timeout connecting to drachtio-server at ${this.config.drachtioHost}:${this.config.drachtioPort}`,
          ),
        );
      }, 10_000);

      onFn.call(srf, "connect", (err: unknown, hostPort: unknown) => {
        clearTimeout(timeout);
        if (err) {
          reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
          return;
        }
        this.connected = true;
        console.log(`[threecx] Connected to drachtio-server at ${String(hostPort)}`);
        resolve();
      });

      onFn.call(srf, "error", (err: unknown) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
      });

      connectFn.call(srf, {
        host: this.config.drachtioHost,
        port: this.config.drachtioPort,
        secret: this.config.drachtioSecret,
      });
    });

    // Resolve public IP for Contact header (NAT traversal)
    if (this.config.externalIp) {
      this.contactHost = this.config.externalIp;
    } else {
      try {
        const resp = await fetch("https://api.ipify.org");
        if (resp.ok) {
          this.contactHost = (await resp.text()).trim();
          console.log(`[threecx] Auto-detected public IP: ${this.contactHost}`);
        }
      } catch {
        console.warn("[threecx] Could not auto-detect public IP; using domain for Contact");
        this.contactHost = this.config.domain;
      }
    }

    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "threecx.ts:connect",
        message: "Connection config resolved",
        data: {
          contactHost: this.contactHost,
          externalIp: this.config.externalIp,
          extension: this.config.extension,
          authId: this.config.authId,
          domain: this.config.domain,
          server: this.config.server,
          rtpPortMin: this.config.rtpPortMin,
          rtpPortMax: this.config.rtpPortMax,
        },
        hypothesisId: "A,B,C,E",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    // Set up handler for inbound SIP INVITE
    const inviteFn = srf.invite as (cb: (req: unknown, res: unknown) => void) => void;
    inviteFn.call(srf, (req: unknown, res: unknown) => {
      this.handleInboundCall(req, res).catch((err) => {
        console.error("[threecx] Error handling inbound call:", err);
      });
    });

    // Register with the SIP trunk provider
    await this.sendRegister();

    // Re-register periodically (SIP registrations expire)
    this.registerTimer = setInterval(() => {
      this.sendRegister().catch((err) => {
        console.error("[threecx] Re-registration failed:", err);
      });
    }, 120_000); // Re-register every 2 minutes

    console.log(`[threecx] Registered as ${this.config.extension}@${this.config.domain}`);
  }

  /**
   * Send a SIP REGISTER request to the trunk provider.
   */
  private async sendRegister(): Promise<void> {
    if (!this.srf) {
      throw new Error("Not connected to drachtio-server");
    }

    const srf = this.srf as Record<string, unknown>;
    // drachtio-srf request() expects: request(uri, opts, callback)
    // Passing the URI as the first positional arg (not inside opts) avoids
    // a URI-mangling bug where drachtio injects wss:// into the Request-URI.
    const requestFn = srf.request as (
      uri: string,
      opts: Record<string, unknown>,
      cb: (err: unknown, req: unknown) => void,
    ) => void;

    // Use TCP transport so 3CX sends INVITEs over the same persistent connection,
    // bypassing Docker Desktop NAT (which randomises UDP source ports).
    const registrarUri = `sip:${this.config.server};transport=tcp`;

    return new Promise<void>((resolve, reject) => {
      requestFn.call(
        srf,
        registrarUri,
        {
          method: "REGISTER",
          headers: {
            From: `<sip:${this.config.extension}@${this.config.domain}>`,
            To: `<sip:${this.config.extension}@${this.config.domain}>`,
            Contact: `<sip:${this.config.extension}@${this.contactHost}:5060;transport=tcp>`,
            Expires: "300",
            "User-Agent": "OpenClaw/1.0",
          },
          auth: {
            username: this.config.authId,
            password: this.config.password,
          },
        },
        (err: unknown, req: unknown) => {
          if (err) {
            this.registered = false;
            return reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
          }

          const sipReq = req as {
            on: (event: string, cb: (res: { status: number; statusCode?: number }) => void) => void;
          };

          sipReq.on("response", (res) => {
            const status = res.statusCode ?? res.status;
            // #region agent log
            fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "threecx.ts:sendRegister:response",
                message: "REGISTER response",
                data: {
                  status,
                  contactHeader: `<sip:${this.config.extension}@${this.contactHost}:5060;transport=tcp>`,
                  authId: this.config.authId,
                },
                hypothesisId: "A,B",
                timestamp: Date.now(),
              }),
            }).catch(() => {});
            // #endregion
            if (status === 200) {
              const wasRegistered = this.registered;
              this.registered = true;
              // First registration is info-level; periodic re-registrations are debug
              // to avoid spamming the log every 4-5 minutes.
              if (wasRegistered) {
                console.debug("[threecx] SIP REGISTER refreshed (200 OK)");
              } else {
                console.log("[threecx] SIP REGISTER successful (200 OK)");
              }
              resolve();
            } else {
              this.registered = false;
              console.error(`[threecx] SIP REGISTER failed: ${status}`);
              reject(new Error(`REGISTER failed with status ${status}`));
            }
          });
        },
      );
    });
  }

  /**
   * Gracefully disconnect: unregister and close connection.
   */
  async disconnect(): Promise<void> {
    // Stop re-registration timer
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }

    // End all active calls
    for (const [callId, session] of this.sessions) {
      try {
        await this.hangupCall({
          callId,
          providerCallId: session.providerCallId,
          reason: "hangup-bot",
        });
      } catch {
        // Best-effort cleanup
      }
    }

    // Clear port tracking (prevents stale allocations after restart)
    ThreeCXMediaBridge.clearAllocatedPorts();

    // Send REGISTER with Expires: 0 to unregister
    if (this.srf && this.registered) {
      try {
        const srf = this.srf as Record<string, unknown>;
        const requestFn = srf.request as (
          uri: string,
          opts: Record<string, unknown>,
          cb: (err: unknown, req: unknown) => void,
        ) => void;

        await new Promise<void>((resolve) => {
          requestFn.call(
            srf,
            `sip:${this.config.server};transport=tcp`,
            {
              method: "REGISTER",
              headers: {
                From: `<sip:${this.config.extension}@${this.config.domain}>`,
                To: `<sip:${this.config.extension}@${this.config.domain}>`,
                Contact: `<sip:${this.config.extension}@${this.contactHost}:5060;transport=tcp>`,
                Expires: "0",
                "User-Agent": "OpenClaw/1.0",
              },
              auth: {
                username: this.config.authId,
                password: this.config.password,
              },
            },
            () => {
              resolve();
            },
          );
        });
      } catch {
        // Best-effort
      }
    }

    if (this.srf) {
      try {
        const srf = this.srf as Record<string, unknown>;
        const disconnectFn = srf.disconnect as (() => void) | undefined;
        disconnectFn?.call(srf);
      } catch {
        // Best-effort
      }
    }

    this.connected = false;
    this.registered = false;
    this.srf = null;
    console.log("[threecx] Disconnected");
  }

  /** Whether the provider is registered and ready */
  get isRegistered(): boolean {
    return this.registered;
  }

  // ---------------------------------------------------------------------------
  // Inbound Call Handling
  // ---------------------------------------------------------------------------

  /**
   * Handle an incoming SIP INVITE (inbound call from trunk).
   */
  private async handleInboundCall(req: unknown, res: unknown): Promise<void> {
    const sipReq = req as {
      callingNumber?: string;
      calledNumber?: string;
      callId?: string;
      get?: (name: string) => string;
      body?: string;
      sdp?: string;
    };

    const callId = crypto.randomUUID();
    const providerCallId = sipReq.callId || crypto.randomUUID();
    const from = sipReq.callingNumber || "unknown";
    const to = sipReq.calledNumber || this.config.extension;

    console.log(`[threecx] Inbound call from ${from} -> ${to} (callId: ${callId})`);

    // Emit initiated event
    this.emitEvent({
      id: crypto.randomUUID(),
      callId,
      providerCallId,
      timestamp: Date.now(),
      type: "call.initiated",
      direction: "inbound",
      from,
      to,
    });

    // Emit ringing
    this.emitEvent({
      id: crypto.randomUUID(),
      callId,
      providerCallId,
      timestamp: Date.now(),
      type: "call.ringing",
      direction: "inbound",
      from,
      to,
    });

    // Declare mediaBridge outside try block so it can be cleaned up on error
    let mediaBridge: ThreeCXMediaBridge | null = null;

    try {
      // Create the media bridge and start RTP
      mediaBridge = new ThreeCXMediaBridge({
        rtpPortMin: this.config.rtpPortMin,
        rtpPortMax: this.config.rtpPortMax,
      });

      const _localRtpPort = await mediaBridge.startRtp();

      // Use public IP (contactHost) for SDP so remote endpoints can reach us
      const sdpIp = this.contactHost !== "localhost" ? this.contactHost : getLocalIp();
      const localSdp = mediaBridge.generateSdp(sdpIp);

      // Answer the call with 200 OK + our SDP
      const srf = this.srf as Record<string, unknown>;
      const createUAS = srf.createUAS as (
        req: unknown,
        res: unknown,
        opts: { localSdp: string },
      ) => Promise<unknown>;

      const dialog = await createUAS.call(srf, req, res, { localSdp });

      // Parse the remote SDP to get the caller's RTP endpoint
      const remoteSdp =
        (dialog as { remote?: { sdp?: string } }).remote?.sdp || sipReq.sdp || sipReq.body || "";
      const remoteEndpoint = ThreeCXMediaBridge.parseRemoteSdp(remoteSdp);
      if (remoteEndpoint) {
        mediaBridge.setRemoteEndpoint(remoteEndpoint.host, remoteEndpoint.port);
      }

      const session: SipSession = {
        callId,
        providerCallId,
        direction: "inbound",
        from,
        to,
        dialog,
        mediaBridge,
        startedAt: Date.now(),
        ttsAbortController: null,
      };
      this.sessions.set(callId, session);

      // Emit answered
      this.emitEvent({
        id: crypto.randomUUID(),
        callId,
        providerCallId,
        timestamp: Date.now(),
        type: "call.answered",
        direction: "inbound",
        from,
        to,
      });

      // Listen for BYE (caller hangs up)
      const dlg = dialog as { on: (event: string, cb: (...args: unknown[]) => void) => void };
      dlg.on("destroy", () => {
        this.handleSessionEnd(session, "hangup-user");
      });
    } catch (err) {
      console.error(
        `[threecx] Failed to accept inbound call: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      );

      // Clean up the media bridge if it was created (prevents port leak)
      if (mediaBridge) {
        mediaBridge.close();
      }

      // Try to send a rejection
      try {
        const sipRes = res as { send: (status: number) => void };
        sipRes.send(500);
      } catch {
        // Best-effort
      }

      this.emitEvent({
        id: crypto.randomUUID(),
        callId,
        providerCallId,
        timestamp: Date.now(),
        type: "call.error",
        error: `Accept failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      });
    }
  }

  /**
   * Clean up a session and emit ended event.
   */
  private handleSessionEnd(session: SipSession, reason: EndReason): void {
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "threecx.ts:handleSessionEnd",
        message: "Session cleanup started",
        data: {
          callId: session.callId,
          reason,
          direction: session.direction,
          hasMediaBridge: !!session.mediaBridge,
        },
        hypothesisId: "W,X,Y",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    // Clean up STT session for this call
    const sttSession = this.sttSessions.get(session.callId);
    if (sttSession) {
      sttSession.close();
      this.sttSessions.delete(session.callId);
    }

    // Cancel any pending barge-in debounce timer
    const bargeInTimer = this.bargeInTimers.get(session.callId);
    if (bargeInTimer) {
      clearTimeout(bargeInTimer);
      this.bargeInTimers.delete(session.callId);
    }

    // Abort any in-progress TTS playback
    session.ttsAbortController?.abort();
    session.ttsAbortController = null;

    session.mediaBridge.close();
    this.sessions.delete(session.callId);
    // Clean up any aliases pointing to this session
    for (const [alias, target] of this.callIdAliases) {
      if (target === session.callId) {
        this.callIdAliases.delete(alias);
      }
    }

    this.emitEvent({
      id: crypto.randomUUID(),
      callId: session.callId,
      providerCallId: session.providerCallId,
      timestamp: Date.now(),
      type: "call.ended",
      reason,
    });

    console.log(`[threecx] Call ended: ${session.callId} (reason: ${reason})`);
  }

  // ---------------------------------------------------------------------------
  // VoiceCallProvider Interface
  // ---------------------------------------------------------------------------

  /**
   * No-op: threecx uses SIP events via drachtio, not HTTP webhooks.
   */
  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return {
      ok: true,
      reason: "ThreeCX provider uses SIP via drachtio, not HTTP webhooks",
    };
  }

  /**
   * No-op: events come from SIP messages, not webhook payloads.
   */
  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }

  /**
   * Compute SIP Digest authentication response (MD5).
   * HA1 = MD5(username:realm:password)
   * HA2 = MD5(method:uri)
   * response = MD5(HA1:nonce:HA2)
   */
  private computeDigestResponse(
    username: string,
    password: string,
    realm: string,
    nonce: string,
    method: string,
    uri: string,
  ): string {
    const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    return md5(`${ha1}:${nonce}:${ha2}`);
  }

  /**
   * Parse the Proxy-Authenticate or WWW-Authenticate header value.
   */
  private parseAuthChallenge(
    header: string,
  ): { realm: string; nonce: string; algorithm: string } | null {
    const realmMatch = header.match(/realm="([^"]+)"/);
    const nonceMatch = header.match(/nonce="([^"]+)"/);
    const algoMatch = header.match(/algorithm=(\S+)/);
    if (!realmMatch || !nonceMatch) return null;
    return { realm: realmMatch[1], nonce: nonceMatch[1], algorithm: algoMatch?.[1] ?? "MD5" };
  }

  /**
   * Initiate an outbound call via SIP INVITE (through drachtio-server).
   *
   * Uses transport=tcp and handles the 407 Proxy Auth challenge manually
   * (instead of drachtio's built-in `auth` option) because drachtio's
   * internal auth retry switches from TCP to UDP, which breaks through
   * Docker NAT and results in 3CX rejecting with "403 Invalid credentials".
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (!this.connected || !this.srf) {
      throw new Error("ThreeCX provider not connected. Call connect() first.");
    }

    const mediaBridge = new ThreeCXMediaBridge({
      rtpPortMin: this.config.rtpPortMin,
      rtpPortMax: this.config.rtpPortMax,
    });

    const _localRtpPort = await mediaBridge.startRtp();
    // Use the public IP (contactHost) for SDP so remote endpoints behind
    // NAT can route RTP back to us; fall back to LAN IP if unset.
    const sdpIp = this.contactHost !== "localhost" ? this.contactHost : getLocalIp();
    const localSdp = mediaBridge.generateSdp(sdpIp);

    // Force TCP transport so the INVITE uses the same persistent TCP
    // connection as REGISTER. Without this, drachtio defaults to UDP,
    // and Docker Desktop NAT randomises the source port — causing 3CX
    // to reject with 403.
    const targetUri = `sip:${input.to}@${this.config.domain};transport=tcp`;
    const providerCallId = crypto.randomUUID();

    const srf = this.srf as Record<string, unknown>;
    const requestFn = srf.request as (
      uri: string,
      opts: Record<string, unknown>,
      cb: (err: unknown, req: unknown) => void,
    ) => void;

    // Shared SIP headers for INVITE (used for both initial and auth-retry)
    const sipHeaders = {
      From: `<sip:${this.config.extension}@${this.config.domain}>`,
      To: `<sip:${input.to}@${this.config.domain}>`,
      Contact: `<sip:${this.config.extension}@${this.contactHost}:5060;transport=tcp>`,
      "Content-Type": "application/sdp",
      "User-Agent": "OpenClaw/1.0",
    };

    // #region agent log
    console.error(
      `[voice-call:initiateCall] ENTERED target=${targetUri} sdpIp=${sdpIp} rtpPort=${this.config.rtpPortMin} registered=${this.registered}`,
    );
    fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "threecx.ts:initiateCall",
        message: "INVITE config",
        data: {
          targetUri,
          sdpIp,
          sdpPreview: localSdp.split("\n").slice(0, 6).join(" | "),
          contactHost: this.contactHost,
          extension: this.config.extension,
          authId: this.config.authId,
          domain: this.config.domain,
          rtpPortMin: this.config.rtpPortMin,
          rtpPortMax: this.config.rtpPortMax,
          registered: this.registered,
        },
        hypothesisId: "P,Q",
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    /** SIP response shape returned by drachtio */
    type SipResponse = {
      status: number;
      statusCode?: number;
      body?: string;
      msg?: { body?: string };
      headers?: Record<string, string>;
      get?: (name: string) => string | undefined;
    };

    /**
     * Send a single INVITE request and return the **final** SIP response.
     * Provisional (1xx) responses are logged but ignored — we wait for a
     * final response (status >= 200) to resolve the promise.  The `ack`
     * callback from drachtio is stored so the caller can ACK a 200 OK.
     * Includes a ring timeout (30s) to prevent indefinite waiting.
     */
    // Mutable holder so the response callback can store the ACK function
    // (TS can't track assignments inside callbacks for control-flow narrowing)
    const ackHolder: { fn: ((opts?: Record<string, unknown>) => void) | null } = { fn: null };
    const RING_TIMEOUT_MS = 30000; // 30 seconds ring timeout

    const sendInvite = (extraHeaders: Record<string, string> = {}): Promise<SipResponse> =>
      new Promise((resolve, reject) => {
        // Ring timeout to prevent indefinite waiting
        const ringTimeout = setTimeout(() => {
          // #region agent log
          fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "threecx.ts:sendInvite:ringTimeout",
              message: "Ring timeout - call not answered",
              data: { timeoutMs: RING_TIMEOUT_MS, targetUri },
              hypothesisId: "W",
              timestamp: Date.now(),
            }),
          }).catch(() => {});
          // #endregion
          reject(new Error(`Ring timeout: call not answered within ${RING_TIMEOUT_MS}ms`));
        }, RING_TIMEOUT_MS);

        requestFn.call(
          srf,
          targetUri,
          {
            method: "INVITE",
            headers: { ...sipHeaders, ...extraHeaders },
            body: localSdp,
            // NOTE: no `auth` here — we handle 407 manually to keep TCP transport.
          },
          (err: unknown, req: unknown) => {
            if (err) {
              return reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
            }

            const sipReq = req as {
              on: (event: string, cb: (...args: unknown[]) => void) => void;
            };

            sipReq.on("response", (res: unknown, ack: unknown) => {
              const response = res as SipResponse;
              const st = response.statusCode ?? response.status;
              console.error(
                `[voice-call:sendInvite] response event fired: status=${st} hasAck=${typeof ack === "function"}`,
              );

              // Provisional responses (1xx) — keep waiting for the final response
              if (st > 0 && st < 200) {
                // #region agent log
                console.error(
                  `[voice-call:sendInvite] PROVISIONAL ${st} — waiting for final response`,
                );
                fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    location: "threecx.ts:sendInvite:provisional",
                    message: "Provisional response (waiting for final)",
                    data: { status: st },
                    hypothesisId: "J",
                    timestamp: Date.now(),
                  }),
                }).catch(() => {});
                // #endregion
                return; // Don't resolve — wait for the next response event
              }

              // Final response (>= 200): clear timeout, store ack fn and resolve
              clearTimeout(ringTimeout);
              console.error(
                `[voice-call:sendInvite] FINAL response ${st} — resolving promise, hasAck=${typeof ack === "function"}`,
              );
              if (typeof ack === "function") {
                ackHolder.fn = ack as (opts?: Record<string, unknown>) => void;
              }
              resolve(response);
            });
          },
        );
      });

    try {
      // --- First INVITE (expect 407 Proxy Authentication Required) --------
      let response = await sendInvite();
      let status = response.statusCode ?? response.status;

      // #region agent log
      console.error(`[voice-call:initiateCall] first sendInvite resolved: status=${status}`);
      fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "threecx.ts:initiateCall:firstResp",
          message: "INVITE first response",
          data: {
            status,
            hasGet: typeof response.get === "function",
            headerKeys: response.headers ? Object.keys(response.headers) : [],
          },
          hypothesisId: "D",
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      // Handle 407 Proxy Authentication Required
      if (status === 407 || status === 401) {
        // Extract the challenge from Proxy-Authenticate or WWW-Authenticate
        const challengeHeader =
          response.get?.("proxy-authenticate") ??
          response.get?.("www-authenticate") ??
          response.headers?.["proxy-authenticate"] ??
          response.headers?.["www-authenticate"] ??
          "";

        // #region agent log
        fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "threecx.ts:initiateCall:407",
            message: "Handling 407 manually",
            data: { status, challengeHeader: String(challengeHeader).slice(0, 200) },
            hypothesisId: "D",
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion

        const challenge = this.parseAuthChallenge(String(challengeHeader));
        if (!challenge) {
          throw new Error(`Could not parse authentication challenge: ${challengeHeader}`);
        }

        // Compute Digest response and retry over TCP (same headers + Proxy-Authorization)
        const digestResponse = this.computeDigestResponse(
          this.config.authId,
          this.config.password,
          challenge.realm,
          challenge.nonce,
          "INVITE",
          targetUri.replace(/;transport=tcp$/i, ""), // URI without transport param for digest
        );

        const proxyAuth =
          `Digest username="${this.config.authId}", realm="${challenge.realm}", ` +
          `nonce="${challenge.nonce}", uri="${targetUri.replace(/;transport=tcp$/i, "")}", ` +
          `response="${digestResponse}", algorithm=${challenge.algorithm}`;

        // Second INVITE with Proxy-Authorization — still over TCP
        ackHolder.fn = null; // reset ack for the retry
        response = await sendInvite({ "Proxy-Authorization": proxyAuth });
        status = response.statusCode ?? response.status;

        // #region agent log
        console.error(`[voice-call:initiateCall] auth retry sendInvite resolved: status=${status}`);
        fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "threecx.ts:initiateCall:authRetry",
            message: "INVITE auth retry response",
            data: { status, proxyAuthPrefix: proxyAuth.slice(0, 100) },
            hypothesisId: "D",
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
      }

      console.error(
        `[voice-call:initiateCall] final status check: status=${status} (need 200-299 to proceed)`,
      );
      if (status < 200 || status >= 300) {
        throw new Error(`INVITE failed with status ${status}`);
      }

      // ACK the 200 OK to complete the SIP 3-way handshake
      console.error(`[voice-call:initiateCall] sending ACK: hasAckFn=${!!ackHolder.fn}`);
      if (ackHolder.fn) {
        ackHolder.fn();
      }

      // #region agent log
      console.error(
        `[voice-call:initiateCall] INVITE SUCCESS — call connected, status=${status} sdpIp=${sdpIp}`,
      );
      fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "threecx.ts:initiateCall:success",
          message: "INVITE succeeded — call connected",
          data: {
            status,
            sdpIp,
            hasBody: !!(response.body || response.msg?.body),
            acked: !!ackHolder.fn,
          },
          hypothesisId: "P,Q,S",
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      // Wrap response in a dialog-like object for session tracking.
      const dialog = {
        remote: { sdp: response.body || response.msg?.body || "" },
        _destroyed: false,
        destroy(_opts: unknown, cb?: (err: unknown) => void) {
          if (this._destroyed) {
            cb?.(null);
            return;
          }
          this._destroyed = true;
          cb?.(null);
        },
        on(_event: string, _cb: () => void) {
          // With srf.request() drachtio-server doesn't provide dialog-level
          // events; we rely on the RTP bridge closing as a signal.
        },
      };

      // Parse remote SDP for RTP endpoint
      const remoteSdp = (dialog as { remote?: { sdp?: string } }).remote?.sdp || "";
      const remoteEndpoint = ThreeCXMediaBridge.parseRemoteSdp(remoteSdp);
      // #region agent log
      fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "threecx.ts:initiateCall:mediaBridge",
          message: "Media bridge setup",
          data: {
            hasRemoteSdp: !!remoteSdp,
            sdpLen: remoteSdp.length,
            remoteEndpoint: remoteEndpoint ?? null,
            sdpPreview: remoteSdp.slice(0, 300),
          },
          hypothesisId: "L",
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      if (remoteEndpoint) {
        mediaBridge.setRemoteEndpoint(remoteEndpoint.host, remoteEndpoint.port);
      }

      const session: SipSession = {
        callId: input.callId,
        providerCallId,
        direction: "outbound",
        from: input.from,
        to: input.to,
        dialog,
        mediaBridge,
        startedAt: Date.now(),
        ttsAbortController: null,
      };
      this.sessions.set(input.callId, session);

      // Emit events
      this.emitEvent({
        id: crypto.randomUUID(),
        callId: input.callId,
        providerCallId,
        timestamp: Date.now(),
        type: "call.initiated",
      });

      this.emitEvent({
        id: crypto.randomUUID(),
        callId: input.callId,
        providerCallId,
        timestamp: Date.now(),
        type: "call.answered",
      });

      // Listen for remote hangup
      const dlg = dialog as { on: (event: string, cb: () => void) => void };
      dlg.on("destroy", () => {
        this.handleSessionEnd(session, "completed");
      });

      return { providerCallId, status: "initiated" };
    } catch (err) {
      // #region agent log
      fetch("http://127.0.0.1:7245/ingest/bb17bc8b-bc5f-4f49-b97d-e45c4a6a3bda", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "threecx.ts:initiateCall:catch",
          message: "INVITE FAILED",
          data: {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
            targetUri,
            contactHost: this.contactHost,
          },
          hypothesisId: "A,B,D",
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      mediaBridge.close();
      throw new Error(
        `Outbound call failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * Hang up an active call via SIP BYE.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const session = this.findSession(input.callId);
    if (!session) {
      console.warn(`[threecx] hangupCall: no session for callId ${input.callId}`);
      return;
    }

    try {
      const dialog = session.dialog as {
        destroy?: (opts?: unknown, cb?: (err: unknown) => void) => void;
      };

      if (dialog.destroy) {
        await new Promise<void>((resolve) => {
          dialog.destroy!({}, (err: unknown) => {
            if (err) {
              console.error(
                `[threecx] Error sending BYE: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
              );
            }
            resolve();
          });
        });
      }
    } catch (err) {
      console.error(`[threecx] Error hanging up call ${input.callId}:`, err);
    }

    this.handleSessionEnd(session, input.reason);
  }

  /**
   * In-memory TTS phrase cache: avoids re-synthesizing identical text.
   * Keyed by the raw text; stores the synthesized mu-law Buffer.
   * Bounded to MAX_TTS_CACHE_ENTRIES entries (LRU eviction).
   */
  private ttsCache = new Map<string, Buffer>();
  private static readonly MAX_TTS_CACHE_ENTRIES = 32;

  /**
   * Play TTS audio through the RTP media bridge.
   * Synthesizes text to mu-law via the injected TTS provider, then streams
   * the resulting audio as RTP packets through the media bridge.
   * Uses an in-memory phrase cache to skip synthesis for repeated/stock phrases.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const session = this.findSession(input.callId);
    if (!session) {
      console.warn(`[threecx] playTts: no session for callId ${input.callId}`);
      return;
    }

    if (!this.ttsProvider) {
      console.warn(`[threecx] playTts: no TTS provider configured, skipping`);
      return;
    }

    // Emit speaking event
    this.emitEvent({
      id: crypto.randomUUID(),
      callId: input.callId,
      providerCallId: session.providerCallId,
      timestamp: Date.now(),
      type: "call.speaking",
      text: input.text,
    });

    try {
      // Check phrase cache first (avoids re-synthesizing stock phrases like greetings)
      let mulawAudio = this.ttsCache.get(input.text);
      let cacheHit = false;

      if (mulawAudio) {
        cacheHit = true;
      } else {
        // Synthesize text to mu-law 8kHz (TelephonyTtsProvider returns mu-law directly)
        mulawAudio = await this.ttsProvider.synthesizeForTelephony(input.text);

        // Cache the result; evict oldest entry if cache is full (LRU)
        if (this.ttsCache.size >= ThreeCXProvider.MAX_TTS_CACHE_ENTRIES) {
          const oldest = this.ttsCache.keys().next().value;
          if (oldest !== undefined) {
            this.ttsCache.delete(oldest);
          }
        }
        this.ttsCache.set(input.text, mulawAudio);
      }

      // Create a fresh AbortController for this TTS playback (barge-in support)
      const ac = new AbortController();
      session.ttsAbortController = ac;

      // Stream the mu-law audio as RTP packets (abortable via barge-in)
      await session.mediaBridge.injectMulaw(mulawAudio, ac.signal);

      // Clear the controller reference after playback completes (or was aborted)
      if (session.ttsAbortController === ac) {
        session.ttsAbortController = null;
      }

      // Don't log an error if TTS was intentionally interrupted by barge-in
      if (ac.signal.aborted) {
        console.log(`[threecx] playTts: interrupted by barge-in on call ${input.callId}`);
        return;
      }

      console.log(
        `[threecx] playTts: spoke ${mulawAudio.length} bytes on call ${input.callId}${cacheHit ? " (cached)" : ""}`,
      );
    } catch (err) {
      console.error(`[threecx] playTts failed: ${err instanceof Error ? err.message : err}`);
      this.emitEvent({
        id: crypto.randomUUID(),
        callId: input.callId,
        providerCallId: session.providerCallId,
        timestamp: Date.now(),
        type: "call.error",
        error: `TTS failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Cancel any active TTS playback for a call (barge-in support).
   * Aborts the current injectMulaw() call so the caller hears silence
   * within ~20ms of the interruption.
   */
  clearTts(callId: string): void {
    const session = this.findSession(callId);
    if (!session) {
      return;
    }
    if (session.ttsAbortController) {
      session.ttsAbortController.abort();
      session.ttsAbortController = null;
    }
  }

  /**
   * Start listening for caller speech via the RTP audio bridge.
   * Creates an OpenAI Realtime STT session and wires raw mu-law audio
   * from the media bridge directly into the STT WebSocket.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    const session = this.findSession(input.callId);
    if (!session) {
      console.warn(`[threecx] startListening: no session for callId ${input.callId}`);
      return;
    }

    // Clean up existing STT session if any
    const existingStt = this.sttSessions.get(input.callId);
    if (existingStt) {
      existingStt.close();
      this.sttSessions.delete(input.callId);
    }

    // Start media bridge capture (emits rawPayload + audio events)
    session.mediaBridge.startCapture();

    if (!this.sttProvider) {
      console.warn(`[threecx] startListening: no STT provider configured, capture-only mode`);
      return;
    }

    try {
      // Create and connect a new STT session
      const sttSession = this.sttProvider.createSession();
      await sttSession.connect();
      this.sttSessions.set(input.callId, sttSession);

      // Wire raw mu-law audio from media bridge directly to STT
      // (OpenAI Realtime API accepts g711_ulaw natively -- no conversion needed)
      session.mediaBridge.on("rawPayload", (mulaw: Buffer) => {
        if (sttSession.isConnected()) {
          sttSession.sendAudio(mulaw);
        }
      });

      // Wire STT speech-start event with barge-in debounce
      sttSession.onSpeechStart(() => {
        // Barge-in: debounce to avoid false triggers from coughs/noise
        if (this.bargeInEnabled) {
          // Clear any existing timer for this call
          const existing = this.bargeInTimers.get(input.callId);
          if (existing) {
            clearTimeout(existing);
          }

          const timer = setTimeout(() => {
            this.bargeInTimers.delete(input.callId);
            this.clearTts(input.callId);
            this.emitEvent({
              id: crypto.randomUUID(),
              callId: input.callId,
              providerCallId: session.providerCallId,
              timestamp: Date.now(),
              type: "call.interrupted",
              transcript: "",
              isFinal: false,
            });
          }, this.bargeInMinDurationMs);
          this.bargeInTimers.set(input.callId, timer);
        }

        // Always emit speech-start event for UI/logging
        this.emitEvent({
          id: crypto.randomUUID(),
          callId: input.callId,
          providerCallId: session.providerCallId,
          timestamp: Date.now(),
          type: "call.speech",
          transcript: "",
          isFinal: false,
        });
      });

      // Cancel barge-in debounce if speech stops too quickly (noise/cough)
      sttSession.onSpeechEnd(() => {
        const timer = this.bargeInTimers.get(input.callId);
        if (timer) {
          clearTimeout(timer);
          this.bargeInTimers.delete(input.callId);
        }
      });

      // Wire partial transcripts
      sttSession.onPartial((partial: string) => {
        this.emitEvent({
          id: crypto.randomUUID(),
          callId: input.callId,
          providerCallId: session.providerCallId,
          timestamp: Date.now(),
          type: "call.speech",
          transcript: partial,
          isFinal: false,
        });
      });

      // Wire final transcripts
      sttSession.onTranscript((transcript: string) => {
        this.emitEvent({
          id: crypto.randomUUID(),
          callId: input.callId,
          providerCallId: session.providerCallId,
          timestamp: Date.now(),
          type: "call.speech",
          transcript,
          isFinal: true,
        });
      });

      console.log(`[threecx] Started listening with STT on call ${input.callId}`);
    } catch (err) {
      console.error(
        `[threecx] Failed to start STT session: ${err instanceof Error ? err.message : err}`,
      );
      // Capture is still running for raw audio -- just no STT
    }
  }

  /**
   * Stop listening for caller speech and clean up STT session.
   */
  async stopListening(input: StopListeningInput): Promise<void> {
    const session = this.findSession(input.callId);
    if (!session) {
      console.warn(`[threecx] stopListening: no session for callId ${input.callId}`);
      return;
    }

    // Stop media bridge capture
    session.mediaBridge.stopCapture();

    // Clean up STT session
    const sttSession = this.sttSessions.get(input.callId);
    if (sttSession) {
      sttSession.close();
      this.sttSessions.delete(input.callId);
    }

    console.log(`[threecx] Stopped listening on call ${input.callId}`);
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  /** Get the audio bridge for a call (used for direct PCM injection/extraction) */
  getMediaBridge(callId: string): ThreeCXMediaBridge | undefined {
    return this.findSession(callId)?.mediaBridge;
  }

  /** Get active session count */
  get activeCallCount(): number {
    return this.sessions.size;
  }

  /** Get all active call IDs */
  get activeCallIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Get RTP port pool status for debugging/leak detection */
  get portPoolStatus(): { active: number; available: number; ports: number[] } {
    const active = ThreeCXMediaBridge.activePortCount;
    const total = this.config.rtpPortMax - this.config.rtpPortMin + 1;
    return {
      active,
      available: total - active,
      ports: ThreeCXMediaBridge.activePorts,
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Get the first non-loopback IPv4 address.
 * Used for SDP generation so the remote endpoint knows where to send RTP.
 */
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const ifaceList of Object.values(interfaces)) {
    if (!ifaceList) {
      continue;
    }
    for (const iface of ifaceList) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

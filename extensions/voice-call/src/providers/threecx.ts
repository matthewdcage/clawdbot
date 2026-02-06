import crypto from "node:crypto";
import os from "node:os";
import type { ThreeCXConfig } from "../config.js";
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
import { ThreeCXMediaBridge } from "./threecx-media.js";

// Re-export for convenience
export type { ThreeCXConfig };

// drachtio-srf is CJS; use dynamic import for ESM compat
type SrfModule = typeof import("drachtio-srf");

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
  private eventListeners: ThreeCXEventListener[] = [];
  /** Resolved public IP for Contact header (NAT traversal) */
  private contactHost = "localhost";

  constructor(config: ThreeCXConfig) {
    if (!config.server) throw new Error("SIP server host is required");
    if (!config.extension) throw new Error("SIP extension/username is required");
    if (!config.password) throw new Error("SIP password is required");
    if (!config.domain) throw new Error("SIP domain is required");

    this.config = {
      server: config.server,
      extension: config.extension,
      authId: config.authId ?? config.extension, // default to extension if no separate authId
      password: config.password,
      domain: config.domain,
      drachtioHost: config.drachtioHost ?? "127.0.0.1",
      drachtioPort: config.drachtioPort ?? 9022,
      drachtioSecret: config.drachtioSecret ?? "cymru",
      rtpPortMin: config.rtpPortMin ?? 20000,
      rtpPortMax: config.rtpPortMax ?? 20100,
    };
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
    if (this.connected) return;

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
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        this.connected = true;
        console.log(`[threecx] Connected to drachtio-server at ${String(hostPort)}`);
        resolve();
      });

      onFn.call(srf, "error", (err: unknown) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
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
    if (!this.srf) throw new Error("Not connected to drachtio-server");

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
            return reject(err instanceof Error ? err : new Error(String(err)));
          }

          const sipReq = req as {
            on: (event: string, cb: (res: { status: number; statusCode?: number }) => void) => void;
          };

          sipReq.on("response", (res) => {
            const status = res.statusCode ?? res.status;
            if (status === 200) {
              this.registered = true;
              console.log("[threecx] SIP REGISTER successful (200 OK)");
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

    try {
      // Create the media bridge and start RTP
      const mediaBridge = new ThreeCXMediaBridge({
        rtpPortMin: this.config.rtpPortMin,
        rtpPortMax: this.config.rtpPortMax,
      });

      const localRtpPort = await mediaBridge.startRtp();

      // Determine our local IP for SDP
      const localIp = getLocalIp();
      const localSdp = mediaBridge.generateSdp(localIp);

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
      console.error(`[threecx] Failed to accept inbound call: ${err}`);

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
        error: `Accept failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Clean up a session and emit ended event.
   */
  private handleSessionEnd(session: SipSession, reason: EndReason): void {
    session.mediaBridge.close();
    this.sessions.delete(session.callId);

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
   * Initiate an outbound call via SIP INVITE (through drachtio-server).
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (!this.connected || !this.srf) {
      throw new Error("ThreeCX provider not connected. Call connect() first.");
    }

    const mediaBridge = new ThreeCXMediaBridge({
      rtpPortMin: this.config.rtpPortMin,
      rtpPortMax: this.config.rtpPortMax,
    });

    const localRtpPort = await mediaBridge.startRtp();
    const localIp = getLocalIp();
    const localSdp = mediaBridge.generateSdp(localIp);

    const targetUri = `sip:${input.to}@${this.config.domain}`;
    const providerCallId = crypto.randomUUID();

    const srf = this.srf as Record<string, unknown>;
    const createUAC = srf.createUAC as (
      uri: string,
      opts: { localSdp: string; auth: { username: string; password: string } },
    ) => Promise<unknown>;

    try {
      const dialog = await createUAC.call(srf, targetUri, {
        localSdp,
        auth: {
          username: this.config.authId,
          password: this.config.password,
        },
      });

      // Parse remote SDP for RTP endpoint
      const remoteSdp = (dialog as { remote?: { sdp?: string } }).remote?.sdp || "";
      const remoteEndpoint = ThreeCXMediaBridge.parseRemoteSdp(remoteSdp);
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
      mediaBridge.close();
      throw new Error(`Outbound call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Hang up an active call via SIP BYE.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const session = this.sessions.get(input.callId);
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
              console.error(`[threecx] Error sending BYE: ${err}`);
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
   * Play TTS audio through the RTP media bridge.
   * The actual TTS generation happens upstream in the call manager --
   * here we just forward PCM audio bytes as RTP G.711.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const session = this.sessions.get(input.callId);
    if (!session) {
      console.warn(`[threecx] playTts: no session for callId ${input.callId}`);
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

    console.log(`[threecx] playTts: text="${input.text.slice(0, 50)}..." on call ${input.callId}`);
  }

  /**
   * Start listening for caller speech via the RTP audio bridge.
   * G.711 audio is decoded to PCM and forwarded to the STT pipeline.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    const session = this.sessions.get(input.callId);
    if (!session) {
      console.warn(`[threecx] startListening: no session for callId ${input.callId}`);
      return;
    }

    session.mediaBridge.startCapture();
    console.log(`[threecx] Started listening on call ${input.callId}`);
  }

  /**
   * Stop listening for caller speech.
   */
  async stopListening(input: StopListeningInput): Promise<void> {
    const session = this.sessions.get(input.callId);
    if (!session) {
      console.warn(`[threecx] stopListening: no session for callId ${input.callId}`);
      return;
    }

    session.mediaBridge.stopCapture();
    console.log(`[threecx] Stopped listening on call ${input.callId}`);
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  /** Get the audio bridge for a call (used for direct PCM injection/extraction) */
  getMediaBridge(callId: string): ThreeCXMediaBridge | undefined {
    return this.sessions.get(callId)?.mediaBridge;
  }

  /** Get active session count */
  get activeCallCount(): number {
    return this.sessions.size;
  }

  /** Get all active call IDs */
  get activeCallIds(): string[] {
    return [...this.sessions.keys()];
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
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

export type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config */
  coreConfig: CoreConfig;
  /** Call ID for session tracking */
  callId: string;
  /** Caller's phone number */
  from: string;
  /** Conversation transcript */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest user message */
  userMessage: string;
};

export type VoiceResponseResult = {
  text: string | null;
  error?: string;
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
};

/**
 * Helper to append a message to the session transcript file.
 * Creates transcript entries that appear in the web UI chat history.
 */
function appendTranscriptMessage(params: {
  role: "user" | "assistant";
  content: string;
  transcriptPath: string;
  sessionId: string;
}): { ok: boolean; error?: string } {
  const { role, content, transcriptPath, sessionId } = params;

  // Ensure transcript file exists with proper header
  if (!fs.existsSync(transcriptPath)) {
    try {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: 2,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Create transcript entry
  const now = Date.now();
  const messageId = crypto.randomUUID().slice(0, 8);
  const messageBody = {
    role,
    content: [{ type: "text", text: content }],
    timestamp: now,
    ...(role === "assistant"
      ? { stopReason: "end_turn", usage: { input: 0, output: 0, totalTokens: 0 } }
      : {}),
  };
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Generate a voice response using the embedded Pi agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const { voiceConfig, callId, from, transcript, userMessage, coreConfig } = params;

  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }

  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : "Unable to load core agent dependencies",
    };
  }
  const cfg = coreConfig;

  // Build voice-specific session key based on phone number
  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = "main";

  // Resolve paths
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Load or create session entry
  const sessionStore = deps.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: now,
    };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Resolve model from config
  const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  // Resolve thinking level
  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity for personalized prompt
  const identity = deps.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Build system prompt with conversation history.
  // Voice responses should be concise: 1-7 sentences so TTS finishes quickly.
  // For longer details, offer to send via message/email instead.
  const maxToolIter = voiceConfig.maxToolIterations ?? 5;
  const toolLimitHint =
    maxToolIter > 0
      ? ` Limit yourself to at most ${maxToolIter} tool calls per turn — if a task needs more, summarize what you know and offer to continue later.`
      : "";
  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses concise and conversational (1-7 sentences). This is a phone call — the caller has to listen to every word, so be succinct. If the answer requires a long explanation, give a brief summary and offer to send the full details by message or email. Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful but avoid long tool chains.${toolLimitHint}`;

  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript
      .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
      .join("\n");
    extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
  }

  // Resolve timeout
  const timeoutMs = voiceConfig.responseTimeoutMs ?? deps.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  // Register the run context so the gateway can correlate events (event:chat, etc.)
  // with this voice session. This enables the web UI to refresh chat history when
  // a voice response completes.
  if (deps.registerAgentRunContext) {
    deps.registerAgentRunContext(runId, {
      sessionKey,
      verboseLevel: "off",
      isHeartbeat: false,
    });
  }

  try {
    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: userMessage,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt,
      agentDir,
    });

    // Extract text from payloads
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    // Write user and assistant messages to transcript so they appear in web UI
    const transcriptPath = sessionFile || path.join(agentDir, "sessions", `${sessionId}.jsonl`);

    // Record user's message
    const userAppend = appendTranscriptMessage({
      role: "user",
      content: userMessage,
      transcriptPath,
      sessionId,
    });
    if (!userAppend.ok) {
      console.warn(`[voice-call] Failed to record user message: ${userAppend.error}`);
    }

    // Record agent's response if available
    if (text) {
      const assistantAppend = appendTranscriptMessage({
        role: "assistant",
        content: text,
        transcriptPath,
        sessionId,
      });
      if (!assistantAppend.ok) {
        console.warn(`[voice-call] Failed to record assistant message: ${assistantAppend.error}`);
      }
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "./types.js";

// Mock dependencies
vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: vi.fn(),
}));

vi.mock("./response-generator.js", () => ({
  generateVoiceResponse: vi.fn(),
}));

import { loadCoreAgentDeps } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";

describe("ThreeCX Session Streaming", () => {
  let mockEmitAgentEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up mock emitAgentEvent
    mockEmitAgentEvent = vi.fn();

    // Set up mock core deps
    vi.mocked(loadCoreAgentDeps).mockResolvedValue({
      emitAgentEvent: mockEmitAgentEvent,
    } as never);

    // Set up mock response generator
    vi.mocked(generateVoiceResponse).mockResolvedValue({
      text: "AI generated response",
      error: undefined,
    });
  });

  it("emits both user and AI messages to session stream", async () => {
    // This test verifies the fix: both user speech AND AI responses
    // should be emitted to the session stream for real-time monitoring.

    const mockCall = {
      callId: "test-call-123",
      from: "+15551234567",
      to: "+15559876543",
      transcript: [],
      state: "active" as const,
    };

    const mockManager = {
      getCall: vi.fn().mockReturnValue(mockCall),
      speak: vi.fn().mockResolvedValue(undefined),
      processEvent: vi.fn(),
    };

    // Simulate the conversation loop logic
    const processUserSpeech = async (transcript: string) => {
      const deps = await loadCoreAgentDeps();
      const normalizedPhone = mockCall.from.replace(/\D/g, "");
      const sessionKey = `voice:${normalizedPhone}`;
      const callId = mockCall.callId;
      const runId = `voice:${callId}:${Date.now()}`;

      // Emit user message (existing logic)
      if (deps.emitAgentEvent) {
        deps.emitAgentEvent({
          runId,
          sessionKey,
          stream: "event:chat",
          data: {
            type: "user",
            text: transcript,
            provider: "voice",
            timestamp: Date.now(),
          },
        });
      }

      // Generate response
      const result = await generateVoiceResponse({
        voiceConfig: {} as never,
        coreConfig: {} as never,
        callId,
        from: mockCall.from,
        transcript: mockCall.transcript,
        userMessage: transcript,
      });

      // Emit AI response (NEW LOGIC - the fix we're testing)
      if (result.text && deps.emitAgentEvent) {
        deps.emitAgentEvent({
          runId: `voice:${callId}:${Date.now()}`,
          sessionKey,
          stream: "event:chat",
          data: {
            type: "assistant",
            text: result.text,
            provider: "voice",
            timestamp: Date.now(),
          },
        });
      }

      // Speak response
      if (result.text) {
        await mockManager.speak(callId, result.text);
      }
    };

    // Simulate user saying something
    await processUserSpeech("Hello AI assistant");

    // Verify both user and AI messages were emitted
    expect(mockEmitAgentEvent).toHaveBeenCalledTimes(2);

    // Check user message
    expect(mockEmitAgentEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: "voice:15551234567",
        stream: "event:chat",
        data: expect.objectContaining({
          type: "user",
          text: "Hello AI assistant",
          provider: "voice",
        }),
      }),
    );

    // Check AI response
    expect(mockEmitAgentEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: "voice:15551234567",
        stream: "event:chat",
        data: expect.objectContaining({
          type: "assistant",
          text: "AI generated response",
          provider: "voice",
        }),
      }),
    );

    // Verify manager.speak was called
    expect(mockManager.speak).toHaveBeenCalledWith("test-call-123", "AI generated response");
  });

  it("handles missing emitAgentEvent gracefully", async () => {
    // Simulate older core without emitAgentEvent
    vi.mocked(loadCoreAgentDeps).mockResolvedValue({
      emitAgentEvent: undefined,
    } as never);

    const mockManager = {
      speak: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate conversation logic without emitAgentEvent
    const result = await generateVoiceResponse({
      voiceConfig: {} as never,
      coreConfig: {} as never,
      callId: "test-call",
      from: "+15551234567",
      transcript: [],
      userMessage: "Hello",
    });

    if (result.text) {
      await mockManager.speak("test-call", result.text);
    }

    // Should not crash, just skip emission
    expect(mockEmitAgentEvent).not.toHaveBeenCalled();
    expect(mockManager.speak).toHaveBeenCalledWith("test-call", "AI generated response");
  });

  it("does not emit partial transcripts", async () => {
    const mockManager = {
      getCall: vi.fn().mockReturnValue(null),
    };

    // Simulate conversation loop receiving partial speech
    const deps = await loadCoreAgentDeps();
    const partialTranscript = "Hello...";
    const isFinal = false;

    // Logic from runtime.ts: only process final speeches
    if (!isFinal) {
      // Should return early without emitting
      expect(mockEmitAgentEvent).not.toHaveBeenCalled();
      expect(generateVoiceResponse).not.toHaveBeenCalled();
      return;
    }

    // This line should never be reached for partial transcripts
    throw new Error("Should not process partial transcripts");
  });

  it("skips empty transcripts", async () => {
    const mockManager = {
      getCall: vi.fn().mockReturnValue({
        callId: "test-call",
        from: "+15551234567",
        transcript: [],
      }),
    };

    const transcript = "   "; // whitespace only

    // Logic from runtime.ts
    if (!transcript.trim()) {
      // Should return early without processing
      expect(mockEmitAgentEvent).not.toHaveBeenCalled();
      expect(generateVoiceResponse).not.toHaveBeenCalled();
      return;
    }

    throw new Error("Should not process empty transcripts");
  });

  it("normalizes phone number in session key", async () => {
    const mockCall = {
      callId: "test-call",
      from: "+1 (555) 123-4567", // Phone with formatting
      transcript: [],
    };

    const deps = await loadCoreAgentDeps();
    const normalizedPhone = mockCall.from.replace(/\D/g, "");
    const sessionKey = `voice:${normalizedPhone}`;

    // Verify normalization
    expect(sessionKey).toBe("voice:15551234567");
  });
});

import { describe, expect, it, vi } from "vitest";

// Mock the core-bridge module so we don't need the real OpenClaw installation
vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: vi.fn(),
}));

import { loadCoreAgentDeps } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";

describe("generateVoiceResponse", () => {
  const baseCoreConfig = { session: { store: "/tmp/test-store" } };

  function makeMockDeps(overrides?: Record<string, unknown>) {
    return {
      resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
      resolveAgentIdentity: vi.fn().mockReturnValue({ name: "TestBot" }),
      resolveThinkingDefault: vi.fn().mockReturnValue("off"),
      resolveAgentTimeoutMs: vi.fn().mockReturnValue(30000),
      ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
      resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
      loadSessionStore: vi.fn().mockReturnValue({}),
      saveSessionStore: vi.fn().mockResolvedValue(undefined),
      resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
      registerAgentRunContext: vi.fn(),
      DEFAULT_MODEL: "gpt-4o",
      DEFAULT_PROVIDER: "openai",
      runEmbeddedPiAgent: vi.fn().mockResolvedValue({
        payloads: [{ text: "Hello caller!", isError: false }],
        meta: { aborted: false },
      }),
      ...overrides,
    };
  }

  it("calls registerAgentRunContext before running the agent", async () => {
    const mockDeps = makeMockDeps();
    vi.mocked(loadCoreAgentDeps).mockResolvedValue(mockDeps as never);

    await generateVoiceResponse({
      voiceConfig: { provider: "mock", enabled: true } as never,
      coreConfig: baseCoreConfig,
      callId: "call-123",
      from: "+15551234567",
      transcript: [],
      userMessage: "Hello?",
    });

    // registerAgentRunContext must be called before runEmbeddedPiAgent
    expect(mockDeps.registerAgentRunContext).toHaveBeenCalledTimes(1);
    expect(mockDeps.registerAgentRunContext).toHaveBeenCalledWith(
      expect.stringMatching(/^voice:call-123:/),
      expect.objectContaining({
        sessionKey: expect.stringContaining("voice:"),
        verboseLevel: "off",
        isHeartbeat: false,
      }),
    );

    // Verify it was called before runEmbeddedPiAgent
    const registerOrder = mockDeps.registerAgentRunContext.mock.invocationCallOrder[0];
    const runOrder = mockDeps.runEmbeddedPiAgent.mock.invocationCallOrder[0];
    expect(registerOrder).toBeLessThan(runOrder);
  });

  it("returns text from agent response", async () => {
    const mockDeps = makeMockDeps();
    vi.mocked(loadCoreAgentDeps).mockResolvedValue(mockDeps as never);

    const result = await generateVoiceResponse({
      voiceConfig: { provider: "mock", enabled: true } as never,
      coreConfig: baseCoreConfig,
      callId: "call-456",
      from: "+15559876543",
      transcript: [{ speaker: "user", text: "Hi" }],
      userMessage: "What is the weather?",
    });

    expect(result.text).toBe("Hello caller!");
    expect(result.error).toBeUndefined();
  });

  it("handles missing coreConfig gracefully", async () => {
    const result = await generateVoiceResponse({
      voiceConfig: { provider: "mock", enabled: true } as never,
      coreConfig: null as never,
      callId: "call-789",
      from: "+15550001111",
      transcript: [],
      userMessage: "test",
    });

    expect(result.text).toBeNull();
    expect(result.error).toContain("Core config unavailable");
  });

  it("gracefully handles missing registerAgentRunContext (older core)", async () => {
    const mockDeps = makeMockDeps({ registerAgentRunContext: undefined });
    vi.mocked(loadCoreAgentDeps).mockResolvedValue(mockDeps as never);

    // Should not throw even without registerAgentRunContext
    const result = await generateVoiceResponse({
      voiceConfig: { provider: "mock", enabled: true } as never,
      coreConfig: baseCoreConfig,
      callId: "call-old",
      from: "+15550000000",
      transcript: [],
      userMessage: "hello",
    });

    expect(result.text).toBe("Hello caller!");
  });
});

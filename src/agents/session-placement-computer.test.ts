import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAdmittedHostCapabilityTestFixture } from "./harness/host-capability.test-support.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { withSessionPlacementComputer } from "./session-placement-computer.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import type { ComputerToolTransport } from "./tools/computer-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const transport: ComputerToolTransport = {
  computerUse: {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions: ["screenshot"],
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
  },
  resolveNode: async () => ({ nodeId: "session-desktop" }),
  invoke: async () => {
    throw new Error("Tool construction must not invoke the desktop");
  },
};

describe("session placement computer tool policy", () => {
  it.each([
    { name: "default", tools: {}, allowed: true },
    {
      name: "additive sandbox tools",
      tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
      allowed: true,
    },
    {
      name: "explicit sandbox allow",
      tools: { sandbox: { tools: { allow: ["read"] } } },
      allowed: false,
    },
    {
      name: "explicit sandbox deny",
      tools: { sandbox: { tools: { deny: ["computer"] } } },
      allowed: false,
    },
    { name: "global deny", tools: { deny: ["computer"] }, allowed: false },
    { name: "coding profile", tools: { profile: "coding" as const }, allowed: false },
  ])("applies $name policy to the real harness host tool surface", async ({ tools, allowed }) => {
    const workspaceDir = tempDirs.make("placement-computer-");
    const config: OpenClawConfig = { plugins: { enabled: false }, tools };
    const host = await createAdmittedHostCapabilityTestFixture({
      agentId: "main",
      runId: "run-computer",
      sessionId: "session-computer",
      sessionKey: "agent:main:session-computer",
      cwd: workspaceDir,
      workspaceDir,
      config,
    });
    const options = {
      agentId: "main",
      runId: "run-computer",
      sessionId: "session-computer",
      sessionKey: "agent:main:session-computer",
      workspaceDir,
      config,
      modelHasVision: true,
      sandbox: createAgentToolsSandboxContext({
        workspaceDir,
        tools: resolveSandboxToolPolicyForAgent(config, "main"),
      }),
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    };
    try {
      const ordinary = host.hostCapabilities.createToolSurface?.(options) ?? [];
      expect(ordinary.some((tool) => tool.name === "computer")).toBe(false);
      await withSessionPlacementComputer(
        (run) => {
          expect(run).toBe(host.admittedRunContext.operationalRunInstance);
          return {
            transport,
            sandboxToolPolicy: resolveSandboxToolPolicyForAgent(config, "main", {
              containedToolNames: ["computer"],
            }),
          };
        },
        async () => {
          const bound = host.hostCapabilities.createToolSurface?.(options) ?? [];
          const computer = bound.find((tool) => tool.name === "computer");
          expect(Boolean(computer)).toBe(allowed);
          if (computer) {
            expect(computer.parameters).not.toHaveProperty("properties.node");
            expect(computer.parameters).not.toHaveProperty("properties.gatewayUrl");
            expect(computer.description).toContain("this session's desktop");
          }
        },
      );
      await withSessionPlacementComputer(
        () => null,
        async () => {
          expect(
            host.hostCapabilities
              .createToolSurface?.({ ...options, sandbox: undefined })
              ?.some((tool) => tool.name === "computer"),
          ).toBe(false);
        },
      );
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });
});

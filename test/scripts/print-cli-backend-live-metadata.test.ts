// Print Cli Backend Live Metadata tests cover print cli backend live metadata script behavior.
import { describe, expect, it } from "vitest";
import { resolveCliBackendLiveMetadata } from "../../scripts/print-cli-backend-live-metadata.js";

describe("print-cli-backend-live-metadata", () => {
  it.each(["anthropic", "google"])(
    "does not provision a CLI for the canonical %s API provider",
    async (provider) => {
      expect(await resolveCliBackendLiveMetadata(provider)).toMatchObject({
        command: undefined,
        dockerBinaryName: undefined,
        dockerNpmPackage: undefined,
      });
    },
  );

  it.each([
    ["claude-cli", "claude", /^@anthropic-ai\/claude-code(?:@|$)/u],
    ["google-gemini-cli", "gemini", /^@google\/gemini-cli(?:@|$)/u],
  ] as const)(
    "resolves the explicitly selected %s backend",
    async (provider, binary, npmPackage) => {
      expect(await resolveCliBackendLiveMetadata(provider)).toMatchObject({
        dockerBinaryName: binary,
        dockerNpmPackage: expect.stringMatching(npmPackage),
      });
    },
  );

  it("builds one unsupported codex-cli metadata payload", async () => {
    expect(await resolveCliBackendLiveMetadata("codex-cli")).toEqual({
      provider: "codex-cli",
      unsupported: true,
      reason:
        "codex-cli is no longer a bundled CLI backend. Use openai/* with the Codex app-server runtime instead.",
    });
  });
});

// Live Docker Stage tests cover live docker stage script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("live Docker state staging", () => {
  it.each([
    ["fixture-api,fixture-cli", ""],
    ["", "fixture-api/model,fixture-cli/one,fixture-cli/two"],
  ])(
    "provisions selected CLI packages (%s, %s) and refreshes pinned packages",
    (providers, models) => {
      const root = tempDirs.make("openclaw-live-stage-cli-");
      const binDir = path.join(root, "bin");
      const scriptsDir = path.join(root, "scripts");
      mkdirSync(binDir);
      mkdirSync(scriptsDir);
      writeFileSync(
        path.join(scriptsDir, "print-cli-backend-live-metadata.ts"),
        `const provider = process.argv[2];
console.log(JSON.stringify(provider === "fixture-cli" ? {
  command: "fixture", dockerBinaryName: "fixture", dockerNpmPackage: "@fixture/backend@1.0.0"
} : provider === "unselected-cli" ? {
  command: "unselected", dockerNpmPackage: "@fixture/unselected"
} : {}));\n`,
      );
      const npmPath = path.join(binDir, "npm");
      writeFileSync(
        npmPath,
        '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$3" >> "$INSTALL_LOG"\nmkdir -p "$NPM_CONFIG_PREFIX/bin"\nprintf "#!/usr/bin/env bash\\nprintf fixture-ok" > "$NPM_CONFIG_PREFIX/bin/fixture"\nchmod +x "$NPM_CONFIG_PREFIX/bin/fixture"\n',
      );
      chmodSync(npmPath, 0o755);
      const installLog = path.join(root, "installs.log");
      const result = spawnSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; source "$1"; openclaw_live_prepare_provider_clis "$2" "$3" 10; fixture; openclaw_live_prepare_cli_backend fixture "" 10; openclaw_live_prepare_provider_clis fixture-cli "" 10; openclaw_live_prepare_provider_clis fixture-api "" 10',
          "test",
          stageScriptPath,
          providers,
          models,
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            NPM_CONFIG_PREFIX: path.join(root, "npm"),
            OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR: scriptsDir,
            INSTALL_LOG: installLog,
          },
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("fixture-ok");
      expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
        "@fixture/backend@1.0.0",
        "@fixture/backend@1.0.0",
      ]);
    },
  );

  it("fails explicitly when a selected backend has no executable or install package", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$2" "" 10',
        "test",
        stageScriptPath,
        path.join(root, "missing-cli"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("CLI backend executable was not provisioned:");
  });

  it("keeps repo-local generated artifacts out of the source copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=.artifacts");
    expect(script).toContain('node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs"');
  });

  it("adds private SDK source exports only to the disposable source stage", () => {
    const root = tempDirs.make("openclaw-live-stage-sdk-");
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "plugin-sdk"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" } }),
    );
    writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["keyed-async-queue"]),
    );
    writeFileSync(path.join(root, "src", "plugin-sdk", "keyed-async-queue.ts"), "export {};\n");

    addStagedPrivatePluginSdkExports(root);

    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      "./plugin-sdk/core": "./dist/plugin-sdk/core.js",
      "./plugin-sdk/keyed-async-queue": {
        types: "./src/plugin-sdk/keyed-async-queue.ts",
        default: "./src/plugin-sdk/keyed-async-queue.ts",
      },
    });
  });

  it("keeps host-only generated registry state out of the container copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=workspace");
    expect(script).toContain("--exclude=sandboxes");
    expect(script).toContain("--exclude=plugins/installs.json");
    expect(script).toContain("--exclude=plugins/installs.json.migrated");
    expect(script).toContain(
      `db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run("plugins.installedIndex");`,
    );
    expect(script).toContain("PRAGMA secure_delete = ON");
    expect(script).toContain("VACUUM");
    expect(script).toContain("host-absolute paths");
  });
});

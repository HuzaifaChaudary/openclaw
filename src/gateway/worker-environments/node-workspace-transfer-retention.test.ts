import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "../github-publication-git-transport.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";
import {
  deleteStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["git", "git-with-empty-include", "plain"])(
  "reconciles private inputs staged after dispatch through the node transport (%s)",
  async (mode) => {
    const root = await fs.realpath(tempDirs.make("node-workspace-input-retention-"));
    const localPath = path.join(root, "gateway-workspace");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "project.txt"), "existing project file\n");
    await fs.writeFile(path.join(localPath, ".gitignore"), "unrelated-private.txt\n");
    if (mode === "git-with-empty-include") {
      await fs.writeFile(path.join(localPath, ".worktreeinclude"), "");
    }
    if (mode !== "plain") {
      await requireGit(localPath, ["init", "--quiet"]);
      await requireGit(localPath, ["add", "."]);
      await requireGit(localPath, [
        "-c",
        "user.name=Workspace Test",
        "-c",
        "user.email=workspace@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base before attachments",
      ]);
    }
    const owner = new AbortController();
    const environmentId = "input-worker";
    const sessionId = "input-session";
    const ownerEpoch = 1;
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: { ownerEpoch, sessionId, expiresAtMs: Date.now() + 60_000 },
        environment: {
          ownerEpoch,
          attachedSessionIds: [sessionId],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfers"),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
    const actions = createNodeWorkerWorkspaceActions({
      environmentId,
      ownerEpoch,
      sessionId,
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      workspaceTransfer: service,
      runWorkspaceCommand: (command) =>
        runtime.exec(
          {
            ...command,
            argv: [...command.argv],
            gatewayNamespace: "gateway-input-test",
            environmentId,
            sessionId,
            generation: ownerEpoch,
          },
          command.signal,
          { url: server.gatewayUrl },
        ),
    });
    try {
      const synced = await actions.syncWorkspace({ localPath, sessionId, generation: ownerEpoch });
      expect(synced.mode).toBe(mode === "plain" ? "plain" : "git");
      const remote = synced.remoteWorkspaceDir;
      let baseManifestRef = synced.manifestRef;
      let pending: WorkerWorkspaceReconciliationJournal | undefined;
      const reconcile = async (claimId: string) => {
        const ref = workerWorkspaceResultRef(claimId);
        let recorded: string | undefined;
        const quiescence = await actions.quiesceWorkspace(remote);
        try {
          const result = await actions.reconcileWorkspace({
            localPath,
            remoteWorkspaceDir: remote,
            baseManifestRef,
            journal: {
              load: () => pending,
              begin: (next) => {
                pending = next;
              },
              commit: (accepted) => {
                baseManifestRef = accepted;
                pending = undefined;
              },
              abort: () => {
                pending = undefined;
              },
            },
            stagedResult: {
              ref,
              record: (value) => {
                recorded = value;
              },
            },
          });
          const applied = await verifyReconciledWorkspaceFinal(result, quiescence);
          expect(applied?.conflictPaths).toEqual([]);
          expect(recorded).toBe(ref);
          expect(baseManifestRef).toBe(result.manifestRef);
          await deleteStagedWorkerWorkspaceResult({ root: localPath, stagedResultRef: ref });
        } finally {
          await quiescence.resume();
        }
      };
      const attachmentsRoot = path.join(root, "attachments");
      await fs.mkdir(attachmentsRoot);
      const directory = stagedInputDirectory("a".repeat(64));
      await ensureStagedInputDirectory(attachmentsRoot, directory);
      const notesPath = `${directory}/${stagedInputFileName("notes.txt")}`;
      const pngPath = `${directory}/${stagedInputFileName("image.png")}`;
      const png = createSolidPngBuffer(3, 3, { r: 255, g: 0, b: 0 });
      const originalNotes = Buffer.from("original private notes\n");
      const expected = new Map([
        [notesPath, originalNotes],
        [pngPath, png],
        [`${directory}/${stagedInputFileName(".gitignore")}`, Buffer.from("!*\n")],
        [
          `${directory}/${stagedInputFileName(".git")}`,
          Buffer.from("ordinary input, not Git metadata\n"),
        ],
      ]);
      for (const [relative, bytes] of expected) {
        await fs.writeFile(path.join(attachmentsRoot, relative), bytes);
      }
      expected.set(
        `${directory}/.gitignore`,
        await fs.readFile(path.join(attachmentsRoot, directory, ".gitignore")),
      );
      const stage = () =>
        actions.stageAttachments!({
          localPath: attachmentsRoot,
          isAuthorized: () => !owner.signal.aborted,
          signal: owner.signal,
        });
      await stage();
      const editedNotes = Buffer.from("original private notes\nINPUT_EDIT_PRESERVED\n");
      await fs.writeFile(path.join(remote, notesPath), editedNotes);
      expected.set(notesPath, editedNotes);
      await fs.copyFile(path.join(remote, pngPath), path.join(remote, "proof-output.png"));
      await fs.writeFile(path.join(remote, "unrelated-keep.txt"), "unrelated worker file\n");
      await fs.writeFile(path.join(remote, "unrelated-private.txt"), "unselected ignored file\n");

      const assertRetained = async () => {
        for (const [relative, bytes] of expected) {
          // Assert Gateway bytes first: a successful upload alone did not prove retention.
          await expect(fs.readFile(path.join(localPath, relative))).resolves.toEqual(bytes);
          await expect(fs.readFile(path.join(remote, relative))).resolves.toEqual(bytes);
        }
        await expect(fs.readFile(path.join(localPath, "proof-output.png"))).resolves.toEqual(png);
        await expect(fs.readFile(path.join(localPath, "unrelated-keep.txt"), "utf8")).resolves.toBe(
          "unrelated worker file\n",
        );
        await expect(fs.readFile(path.join(localPath, "project.txt"), "utf8")).resolves.toBe(
          "existing project file\n",
        );
        if (mode !== "plain") {
          await expect(
            fs.stat(path.join(localPath, "unrelated-private.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const publication = await captureGitHubPublicationWorkspaceSnapshot({ cwd: localPath });
          const published = (
            await requireGit(localPath, ["ls-tree", "-r", "--name-only", publication.workspaceTree])
          ).split("\n");
          expect(published).toEqual(
            expect.arrayContaining(["project.txt", "proof-output.png", "unrelated-keep.txt"]),
          );
          for (const relative of expected.keys()) {
            expect(published).not.toContain(relative);
          }
          expect(await requireGit(localPath, ["ls-files", "--", "media/inbound"])).toBe("");
        }
      };
      await reconcile("first-input-turn");
      await assertRetained();

      const nextDirectory = stagedInputDirectory("b".repeat(64));
      await ensureStagedInputDirectory(attachmentsRoot, nextDirectory);
      const nextPath = `${nextDirectory}/${stagedInputFileName("next.txt")}`;
      const nextBytes = Buffer.from("next turn input\n");
      await fs.writeFile(path.join(attachmentsRoot, nextPath), nextBytes);
      expected.set(nextPath, nextBytes);
      expected.set(
        `${nextDirectory}/.gitignore`,
        await fs.readFile(path.join(attachmentsRoot, nextDirectory, ".gitignore")),
      );
      // The source still contains originalNotes; repeated staging must preserve the worker edit.
      await stage();
      await expect(fs.readFile(path.join(remote, notesPath))).resolves.toEqual(editedNotes);
      await reconcile("next-input-turn");
      await assertRetained();
    } finally {
      owner.abort();
      await service.closeAll();
      await server.close();
    }
  },
);

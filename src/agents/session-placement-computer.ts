import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import type { ComputerToolTransport } from "./tools/computer-tool.js";

type PlacementComputerFactory = (
  run: OperationalRunInstanceRef | undefined,
) => { transport: ComputerToolTransport; sandboxToolPolicy: SandboxToolPolicy } | null;

const placementComputer = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementComputer"),
  () => new AsyncLocalStorage<PlacementComputerFactory>(),
);

/** Absence means ordinary node routing; null explicitly withholds an unavailable placed desktop. */
export function resolveSessionPlacementComputer(run: OperationalRunInstanceRef | undefined) {
  return placementComputer.getStore()?.(run);
}

export function withSessionPlacementComputer<T>(
  factory: PlacementComputerFactory,
  run: () => Promise<T>,
): Promise<T> {
  return placementComputer.run(factory, run);
}

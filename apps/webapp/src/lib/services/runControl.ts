import { Data, Layer, ServiceMap } from "effect";

export class RunKilledError extends Data.TaggedError("RunKilledError")<{
  readonly runId: string;
  readonly threadId: string;
  readonly message: string;
}> {}

interface RunControlEntry {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly controller: AbortController;
  sandboxId: string | null;
}

export interface RunControlDef {
  registerRun: (input: {
    readonly runId: string;
    readonly threadId: string;
    readonly userId: string;
  }) => void;
  getSignal: (runId: string) => AbortSignal | null;
  setSandboxId: (runId: string, sandboxId: string) => void;
  abortRun: (runId: string) => { readonly sandboxId: string | null } | null;
  clearRun: (runId: string) => void;
  isAborted: (runId: string) => boolean;
  throwIfAborted: (input: {
    readonly runId: string;
    readonly threadId: string;
    readonly message?: string;
  }) => void;
}

export class RunControlService extends ServiceMap.Service<RunControlService, RunControlDef>()(
  "RunControlService",
) {
  static readonly layer = Layer.sync(RunControlService, () => {
    const entries = new Map<string, RunControlEntry>();

    return {
      registerRun: ({ runId, threadId, userId }) => {
        entries.set(runId, {
          runId,
          threadId,
          userId,
          controller: new AbortController(),
          sandboxId: null,
        });
      },
      getSignal: (runId) => entries.get(runId)?.controller.signal ?? null,
      setSandboxId: (runId, sandboxId) => {
        const entry = entries.get(runId);

        if (!entry) {
          return;
        }

        entry.sandboxId = sandboxId;
      },
      abortRun: (runId) => {
        const entry = entries.get(runId);

        if (!entry) {
          return null;
        }

        entry.controller.abort();

        return {
          sandboxId: entry.sandboxId,
        };
      },
      clearRun: (runId) => {
        entries.delete(runId);
      },
      isAborted: (runId) => entries.get(runId)?.controller.signal.aborted ?? false,
      throwIfAborted: ({ runId, threadId, message }) => {
        if (!entries.get(runId)?.controller.signal.aborted) {
          return;
        }

        throw new RunKilledError({
          runId,
          threadId,
          message: message ?? "The agent run was stopped.",
        });
      },
    };
  });
}

import { spawn } from "node:child_process";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly message: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly cause?: unknown;
}> {}

export const runProcess = (args: {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}) =>
  Effect.tryPromise({
    try: () =>
      new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(args.command, args.args ?? [], {
          cwd: args.cwd,
          env: {
            ...process.env,
            ...args.env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timeoutId: NodeJS.Timeout | undefined;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          fn();
        };

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });

        child.on("error", (cause) => {
          finish(() => reject(cause));
        });

        child.on("close", (exitCode) => {
          finish(() =>
            resolve({
              exitCode: exitCode ?? 0,
              stdout,
              stderr,
            }),
          );
        });

        if (args.timeoutMs !== undefined) {
          timeoutId = setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
            finish(() =>
              reject(
                new Error(
                  `Process timed out after ${args.timeoutMs}ms: ${args.command} ${(
                    args.args ?? []
                  ).join(" ")}`,
                ),
              ),
            );
          }, args.timeoutMs);
          timeoutId.unref();
        }
      }),
    catch: (cause) =>
      new ProcessError({
        message: `Failed to run process "${args.command}".`,
        command: args.command,
        args: args.args ?? [],
        cwd: args.cwd,
        cause,
      }),
  });

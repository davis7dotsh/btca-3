import { mkdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

const execFile = promisify(execFileCallback);

const containerWorkspaceDir = "/workspace";
const defaultImageName = "btca-agent-box";
const defaultWorkspaceDir = join(homedir(), ".btca", "agent-box");
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
};

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type DockerBackendOptions = {
  imageName?: string;
  workspaceDir?: string;
  containerName?: string;
};

const trimOutput = (value: string | Buffer | undefined) => String(value ?? "").trim();

const runProcess = (command: string, args: string[]) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const result = await execFile(command, args);
        return {
          stdout: trimOutput(result.stdout),
          stderr: trimOutput(result.stderr),
          exitCode: 0,
        } satisfies ProcessResult;
      } catch (error) {
        if (error instanceof Error && "code" in error) {
          const failure = error as Error & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            code?: string | number;
          };

          if (typeof failure.code === "number") {
            return {
              stdout: trimOutput(failure.stdout),
              stderr: trimOutput(failure.stderr),
              exitCode: failure.code,
            } satisfies ProcessResult;
          }
        }

        throw error;
      }
    },
    catch: (error) => new Error(`Failed to run ${command}: ${String(error)}`),
  });

const runDockerOrFail = (args: string[], context: string) =>
  runProcess("docker", args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new Error(
              `${context} failed with exit code ${result.exitCode}` +
                (result.stderr ? `: ${result.stderr}` : ""),
            ),
          ),
    ),
  );

const normalizeContainerCwd = (cwd: string | undefined, currentCwd: string) => {
  if (!cwd || cwd === ".") {
    return currentCwd;
  }

  if (cwd.startsWith("/")) {
    return cwd;
  }

  return resolve(currentCwd, cwd);
};

const parseCdCommand = (command: string) => {
  const trimmed = command.trim();
  const match = /^cd\s+(.+)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const path = match[1]?.trim();
  if (!path) {
    return null;
  }

  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    return path.slice(1, -1);
  }

  return path;
};

export const createDockerAgentBoxBackend = (options: DockerBackendOptions = {}) => {
  const imageName = options.imageName ?? defaultImageName;
  const workspaceDir = options.workspaceDir ?? defaultWorkspaceDir;
  const containerName =
    options.containerName ?? `btca-agent-box-${process.pid}-${Date.now().toString(36)}`;

  let currentCwd = containerWorkspaceDir;

  const ensureWorkspaceDir = Effect.tryPromise({
    try: () => mkdir(workspaceDir, { recursive: true }),
    catch: (error) => new Error(`Failed to create workspace dir ${workspaceDir}: ${String(error)}`),
  });

  const ensureDocker = runDockerOrFail(
    ["version", "--format", "{{.Server.Version}}"],
    "Docker preflight",
  ).pipe(
    Effect.tap((result) =>
      Effect.logInfo(`Docker detected (server ${result.stdout || "unknown"})`),
    ),
  );

  const ensureImage = runProcess("docker", ["image", "inspect", imageName]).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) {
        return Effect.logInfo(`Using existing Docker image ${imageName}`);
      }

      return Effect.logInfo(`Building Docker image ${imageName}`).pipe(
        Effect.zipRight(
          runDockerOrFail(
            ["build", "-t", imageName, projectDir],
            `Docker build for image ${imageName}`,
          ),
        ),
        Effect.asVoid,
      );
    }),
  );

  const removeContainerIfPresent = runProcess("docker", ["rm", "-f", containerName]).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0 || result.stderr.includes("No such container")
        ? Effect.void
        : Effect.fail(
            new Error(
              `Failed to remove existing container ${containerName}: ${result.stderr || result.stdout}`,
            ),
          ),
    ),
  );

  const start = Effect.gen(function* () {
    yield* Effect.logInfo(`Preparing workspace at ${workspaceDir}`);
    yield* ensureWorkspaceDir;
    yield* ensureDocker;
    yield* ensureImage;
    yield* removeContainerIfPresent;
    yield* runDockerOrFail(
      [
        "run",
        "-d",
        "--name",
        containerName,
        "-v",
        `${workspaceDir}:${containerWorkspaceDir}`,
        "-w",
        containerWorkspaceDir,
        imageName,
        "tail",
        "-f",
        "/dev/null",
      ],
      `Docker container start for ${containerName}`,
    );
    currentCwd = containerWorkspaceDir;
    yield* Effect.logInfo(`Started container ${containerName}`);
  });

  const stop = runProcess("docker", ["rm", "-f", containerName]).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0 || result.stderr.includes("No such container")
        ? Effect.logInfo(`Stopped container ${containerName}`)
        : Effect.fail(
            new Error(
              `Failed to stop container ${containerName}: ${result.stderr || result.stdout}`,
            ),
          ),
    ),
  );

  const validateDirectory = (cwd: string) =>
    runDockerOrFail(
      [
        "exec",
        "-w",
        containerWorkspaceDir,
        containerName,
        "bash",
        "-lc",
        `test -d ${JSON.stringify(cwd)}`,
      ],
      `Directory check for ${cwd}`,
    );

  const exec = (command: string, cwd?: string, timeoutSeconds = 120) =>
    Effect.gen(function* () {
      const cdTarget = parseCdCommand(command);
      if (cdTarget) {
        const nextCwd = normalizeContainerCwd(cdTarget, currentCwd);
        yield* validateDirectory(nextCwd);
        currentCwd = nextCwd;

        return {
          stdout: `Changed directory to ${currentCwd}`,
          stderr: "",
          exitCode: 0,
          cwd: currentCwd,
        } satisfies ExecResult;
      }

      const effectiveCwd = normalizeContainerCwd(cwd, currentCwd);
      const result = yield* runDockerOrFail(
        ["exec", "-w", effectiveCwd, containerName, "bash", "-lc", command],
        `Docker exec in ${effectiveCwd}`,
      ).pipe(
        Effect.timeout(`${timeoutSeconds} seconds`),
        Effect.mapError((error) =>
          error instanceof Error
            ? error
            : new Error(`Command timed out after ${timeoutSeconds} seconds`),
        ),
      );

      if (!cwd) {
        currentCwd = effectiveCwd;
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        cwd: effectiveCwd,
      } satisfies ExecResult;
    });

  return {
    imageName,
    workspaceDir,
    containerName,
    getCurrentCwd: () => currentCwd,
    start,
    stop,
    exec,
  };
};

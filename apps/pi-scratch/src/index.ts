import { Effect } from "effect";
import { createDockerAgentBoxBackend } from "./docker-backend.ts";

const backend = createDockerAgentBoxBackend();

const logExec = (label: string, command: string, cwd?: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Running ${label}: ${command}`);
    const result = yield* backend.exec(command, cwd);
    yield* Effect.logInfo(
      JSON.stringify(
        {
          label,
          cwd: result.cwd,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2,
      ),
    );
  });

const program = Effect.gen(function* () {
  yield* backend.start;
  yield* logExec("pwd", "pwd");
  yield* logExec("list workspace", "ls -la");
  yield* logExec("mkdir demo", "mkdir -p demo");
  yield* logExec("cd demo", "cd demo");
  yield* logExec("pwd after cd", "pwd");
  yield* logExec("write file", "printf 'hello from docker backend\n' > hello.txt");
  yield* logExec("read file", "cat hello.txt");
  yield* logExec(
    "tool versions",
    "git --version && npm --version && curl --version | head -n 1 && rg --version | head -n 1",
  );
}).pipe(Effect.ensuring(backend.stop.pipe(Effect.ignoreLogged)));

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

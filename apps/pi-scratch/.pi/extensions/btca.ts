import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { createDockerAgentBoxBackend } from "../../src/docker-backend.ts";

const agentBoxToolName = "agent_box_exec";
const backend = createDockerAgentBoxBackend();

const startBackend = () => Effect.runPromise(backend.start);
const stopBackend = () => Effect.runPromise(backend.stop.pipe(Effect.ignoreLogged));

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    pi.setActiveTools([agentBoxToolName]);
    ctx.ui.setStatus("btca-scratch", ctx.ui.theme.fg("accent", "agent box safe mode"));
    await startBackend();
    ctx.ui.notify(`Agent box ready at ${backend.workspaceDir}`, "info");
  });

  pi.on("session_shutdown", async () => {
    await stopBackend();
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        [
          "BTCA scratch mode:",
          "- Use the agent_box_exec tool for shell access.",
          "- Your persistent workspace is mounted at /workspace inside the agent box.",
          "- The working directory persists between tool calls.",
          "- Use real shell commands like git, npm, curl, and rg inside the box.",
          "- Prefer plain `cd <path>` as its own tool call when you want to change directories persistently.",
        ].join("\n"),
    };
  });

  pi.on("tool_call", async (event) => {
    if (["bash", "read", "write", "edit"].includes(event.toolName)) {
      return {
        block: true,
        reason:
          "Use agent_box_exec instead of host filesystem or host shell tools in btca scratch mode.",
      };
    }
  });

  pi.registerTool({
    name: agentBoxToolName,
    label: "Agent Box Exec",
    description: "Execute a shell command inside the persistent Docker-backed agent box workspace.",
    promptSnippet: "Run shell commands inside the persistent /workspace agent box using Docker.",
    promptGuidelines: [
      "Use this tool for shell access instead of host bash/read/write/edit tools.",
      "Use plain `cd <path>` as a separate call when you want to persistently change directories.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run inside the agent box" }),
      cwd: Type.Optional(
        Type.String({
          description: "Optional working directory inside the agent box, e.g. /workspace/repo",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Optional timeout in seconds", minimum: 1, maximum: 1800 }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await Effect.runPromise(
        backend.exec(params.command, params.cwd, params.timeoutSeconds),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                cwd: result.cwd,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              },
              null,
              2,
            ),
          },
        ],
        details: result,
      };
    },
  });

  pi.registerCommand("agent-box-status", {
    description: "Show agent box backend status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Workspace: ${backend.workspaceDir}`, "info");
      ctx.ui.notify(`Container: ${backend.containerName}`, "info");
      ctx.ui.notify(`Cwd: ${backend.getCurrentCwd()}`, "info");
    },
  });
}

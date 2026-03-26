import * as Console from "effect/Console";
import { ZodJsonSchemaAdapter } from "@tmcp/adapter-zod";
import { StdioTransport } from "@tmcp/transport-stdio";
import * as Effect from "effect/Effect";
import { createRequire } from "node:module";
import * as readline from "node:readline/promises";
import { McpServer } from "tmcp";
import { z } from "zod";
import { Server } from "./server.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const LOCAL_COMMAND = ["bunx", "btca", "mcp"] as const;

const MCP_HARNESSES = [
  {
    id: "cursor",
    label: "Cursor",
    target: ".cursor/mcp.json",
    docsUrl: "https://cursor.com/docs/context/mcp#using-mcpjson",
    snippet: JSON.stringify(
      {
        mcpServers: {
          "btca-local": {
            command: LOCAL_COMMAND[0],
            args: LOCAL_COMMAND.slice(1),
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "codex",
    label: "Codex",
    target: "CLI command",
    docsUrl: "https://developers.openai.com/codex/mcp/",
    snippet: "codex mcp add btca-local -- bunx btca mcp",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    target: "CLI command",
    docsUrl: "https://code.claude.com/docs/en/mcp#installing-mcp-servers",
    snippet: "claude mcp add --transport stdio btca-local -- bunx btca mcp",
  },
  {
    id: "opencode",
    label: "OpenCode",
    target: "opencode.json",
    docsUrl: "https://opencode.ai/docs/mcp-servers/",
    snippet: JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "btca-local": {
            type: "local",
            command: [...LOCAL_COMMAND],
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
  },
] as const;

const promptLine = (question: string) =>
  Effect.tryPromise({
    try: async () => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    catch: (cause) =>
      new Error(cause instanceof Error ? cause.message : "Failed to read input from the terminal."),
  });

const promptHarness = Effect.gen(function* () {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return yield* Effect.fail(new Error("The mcp local command requires an interactive terminal."));
  }

  yield* Console.log("Select an MCP harness:");

  for (const [index, harness] of MCP_HARNESSES.entries()) {
    yield* Console.log(`  ${index + 1}. ${harness.label}`);
  }

  while (true) {
    const response = yield* promptLine("Choose a number: ");
    const selectedIndex = Number.parseInt(response, 10);

    if (
      Number.isInteger(selectedIndex) &&
      selectedIndex >= 1 &&
      selectedIndex <= MCP_HARNESSES.length
    ) {
      return MCP_HARNESSES[selectedIndex - 1]!;
    }

    yield* Console.log(`Enter a number between 1 and ${MCP_HARNESSES.length}.`);
  }
});

const askSchema = z.object({
  question: z.string().min(1).describe("The question to ask BTCA."),
  resources: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional configured resource names or anonymous references like "git:", "npm:", and "local:".',
    ),
});

const toTextResult = (text: string) => ({
  content: [
    {
      type: "text" as const,
      text,
    },
  ],
});

const toJsonResult = (value: unknown) => toTextResult(JSON.stringify(value, null, 2));

const toErrorResult = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    },
  ],
  isError: true as const,
});

const runTool = <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => toErrorResult(error),
        onSuccess: (value) => value,
      }),
    ),
  );

export const runMcpServer = Effect.gen(function* () {
  const server = yield* Server;

  const mcpServer = new McpServer(
    {
      name: "btca-local",
      version,
      description: "BTCA local MCP server (stdio)",
    },
    {
      adapter: new ZodJsonSchemaAdapter(),
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  mcpServer.tool(
    {
      name: "resources",
      description: "Return all available BTCA resources from local config.",
    },
    () =>
      runTool(
        server.getResources().pipe(Effect.map((response) => toJsonResult(response.resources))),
      ),
  );

  mcpServer.tool(
    {
      name: "ask",
      description:
        'Ask BTCA a question against configured resources or anonymous "git:", "npm:", and "local:" references.',
      schema: askSchema,
    },
    ({ question, resources }) =>
      runTool(
        server
          .ask({
            question,
            resourceNames: resources,
            quiet: true,
          })
          .pipe(Effect.map((answer) => toTextResult(answer))),
      ),
  );

  const transport = new StdioTransport(mcpServer);
  transport.listen();

  return yield* Effect.never;
});

export const runMcpLocalSetup = Effect.gen(function* () {
  const harness = yield* promptHarness;
  const fence = harness.target === "CLI command" ? "bash" : "json";

  yield* Console.log("");
  yield* Console.log(`${harness.label} local MCP setup`);
  yield* Console.log(`Paste this into: ${harness.target}`);
  yield* Console.log(`Docs: ${harness.docsUrl}`);
  yield* Console.log("");
  yield* Console.log(`\`\`\`${fence}`);
  yield* Console.log(harness.snippet);
  yield* Console.log("```");
});

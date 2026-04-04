import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const AGENT_WORKSPACE_PATH = "~/.btca/agent/workspace";
const accent = (text: string) => `\x1b[38;2;72;130;234m${text}\x1b[39m`;

const SYSTEM_PROMPT_APPEND = `
You are btca, a local code and documentation research agent.

You operate inside a managed workspace where you can use git, npm, curl, and anything else you need to answer the user's question.

Rules:
- Prefer searching the workspace over answering from memory.
- Use shell tools like rg, find, ls, cat, sed, head, and tail.
- Always clone repos and install npm packages inside the workspace directory
- Cite workspace-relative file paths in your answer when useful.
- Keep the workspace tidy

Workspace root: ${AGENT_WORKSPACE_PATH}

The first thing you should do is cd into the workspace root if you're not already there. Then work to answer the user's question.
`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT_APPEND.trim()}`,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    pi.setActiveTools(["read", "bash"]);

    if (!ctx.hasUI) return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(_width) {
        return [
          "",
          accent("██████╗ ████████╗ ██████╗ █████╗"),
          accent("██╔══██╗╚══██╔══╝██╔════╝██╔══██╗"),
          accent("██████╦╝   ██║   ██║     ███████║"),
          accent("██╔══██╗   ██║   ██║     ██╔══██║"),
          accent("██████╦╝   ██║   ╚██████╗██║  ██║"),
          theme.fg("muted", "╚═════╝    ╚═╝    ╚═════╝╚═╝  ╚═╝"),
          "",
        ];
      },
      invalidate() {},
    }));

    ctx.ui.setFooter((_tui, theme, _footerData) => ({
      invalidate() {},
      render(_width) {
        const model = ctx.model?.id ?? "no-model";
        let totalCost = 0;

        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "message" || entry.message.role !== "assistant")
            continue;
          totalCost += entry.message.usage.cost.total;
        }

        return [
          `${theme.fg("dim", "safe mode")} ${accent(model)} ${theme.fg("muted", `$${totalCost.toFixed(3)}`)}`,
        ];
      },
    }));
  });
}

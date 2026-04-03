import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ACTIVE_TOOLS = ["read", "bash"];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    pi.setActiveTools(ACTIVE_TOOLS);
    ctx.ui.setStatus("btca-scratch", ctx.ui.theme.fg("accent", "btca scratch"));
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        [
          "BTCA scratch mode:",
          "- Prefer working within apps/pi-scratch unless the user asks otherwise.",
          "- Use only the minimum necessary tools.",
          "- Be conservative about file changes.",
        ].join("\n"),
    };
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: "Scratch mode currently blocks file mutations until explicitly enabled.",
      };
    }
  });
}

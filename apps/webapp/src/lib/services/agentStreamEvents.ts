import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  isAgentRunMetrics,
  isExecCommandToolArgs,
  isReadFileToolArgs,
  isSandboxExecuteCommandResult,
  isSandboxReadFileResult,
  type AgentPromptStreamEvent,
} from "$lib/types/agent";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseJsonValue = (value: unknown) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseReadFileArgs = (value: unknown) => {
  const parsed = parseJsonValue(value);
  return isReadFileToolArgs(parsed) ? parsed : null;
};

const parseExecCommandArgs = (value: unknown) => {
  const parsed = parseJsonValue(value);
  return isExecCommandToolArgs(parsed) ? parsed : null;
};

const extractTextContent = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }

      return [];
    })
    .join("\n\n");
};

const extractReasoningContent = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((part) => {
    if (
      isRecord(part) &&
      part.type === "thinking" &&
      typeof part.thinking === "string" &&
      part.thinking.trim().length > 0
    ) {
      return [
        {
          thinking: part.thinking,
          ...(typeof part.thinkingSignature === "string"
            ? { thinkingSignature: part.thinkingSignature }
            : {}),
          ...(typeof part.redacted === "boolean" ? { redacted: part.redacted } : {}),
        },
      ];
    }

    return [];
  });
};

const extractRunMetrics = (event: AgentEvent) => {
  if (!isRecord(event) || !("runMetrics" in event)) {
    return null;
  }

  return isAgentRunMetrics(event.runMetrics) ? event.runMetrics : null;
};

export const normalizeAgentEvent = (event: AgentEvent): AgentPromptStreamEvent[] => {
  const timestamp = Date.now();

  switch (event.type) {
    case "message_update":
      switch (event.assistantMessageEvent.type) {
        case "text_delta":
          return [
            {
              type: "assistant_text_delta",
              delta: event.assistantMessageEvent.delta,
              usage: event.assistantMessageEvent.partial.usage,
              timestamp,
            },
          ];
        case "thinking_start":
          return [
            {
              type: "reasoning_start",
              timestamp,
            },
          ];
        case "thinking_delta":
          return [
            {
              type: "reasoning_delta",
              delta: event.assistantMessageEvent.delta,
              timestamp,
            },
          ];
        case "thinking_end":
          return [
            {
              type: "reasoning_end",
              timestamp,
            },
          ];
        default:
          return [];
      }
    case "message_end": {
      if (event.message.role !== "assistant") {
        return [];
      }

      const content = extractTextContent(event.message.content);
      const reasoning = extractReasoningContent(event.message.content);

      return [
        {
          type: "assistant_message",
          content,
          reasoning,
          usage: event.message.usage,
          api: event.message.api,
          provider: event.message.provider,
          model: event.message.model,
          errorMessage: event.message.errorMessage,
          timestamp,
        },
      ];
    }
    case "tool_execution_start":
      if (event.toolName === "read_file") {
        return [
          {
            type: "tool_call_start",
            toolType: "read_file",
            toolCallId: event.toolCallId,
            args: parseReadFileArgs(event.args),
            timestamp,
          },
        ];
      }

      if (event.toolName === "exec_command") {
        return [
          {
            type: "tool_call_start",
            toolType: "exec_command",
            toolCallId: event.toolCallId,
            args: parseExecCommandArgs(event.args),
            timestamp,
          },
        ];
      }

      return [
        {
          type: "tool_call_start",
          toolType: "unknown",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          timestamp,
        },
      ];
    case "tool_execution_end": {
      const result = isRecord(event.result) ? event.result : null;
      const details = parseJsonValue(result?.details);
      const content = extractTextContent(result?.content);

      if (event.toolName === "read_file") {
        return [
          {
            type: "tool_call_end",
            toolType: "read_file",
            toolCallId: event.toolCallId,
            isError: event.isError,
            content,
            details: isSandboxReadFileResult(details) ? details : null,
            timestamp,
          },
        ];
      }

      if (event.toolName === "exec_command") {
        const normalizedDetails = isSandboxExecuteCommandResult(details) ? details : null;

        return [
          {
            type: "tool_call_end",
            toolType: "exec_command",
            toolCallId: event.toolCallId,
            isError: event.isError || (normalizedDetails?.exitCode ?? 0) !== 0,
            content,
            details: normalizedDetails,
            timestamp,
          },
        ];
      }

      return [
        {
          type: "tool_call_end",
          toolType: "unknown",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          content,
          details,
          timestamp,
        },
      ];
    }
    case "agent_end":
      return [
        ...(extractRunMetrics(event)
          ? [
              {
                type: "run_metrics" as const,
                metrics: extractRunMetrics(event)!,
                timestamp,
              },
            ]
          : []),
        {
          type: "done",
          timestamp,
        },
      ];
    default:
      return [];
  }
};

export const toServerSentEvent = ({ event, id }: { event: AgentPromptStreamEvent; id?: string }) =>
  `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`;

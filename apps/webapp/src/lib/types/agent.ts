import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { AgentModelOption } from "$lib/models";

export interface SandboxReadFileInput {
  readonly threadId: string;
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface SandboxReadFileResult {
  readonly sandboxId: string;
  readonly path: string;
  readonly content: string;
  readonly requestedStartLine?: number;
  readonly requestedEndLine?: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly totalLines: number;
}

export interface SandboxExecuteCommandInput {
  readonly threadId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export interface SandboxExecuteCommandResult {
  readonly sandboxId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly computeMs?: number;
  readonly costUsd?: number;
}

export interface PromptThreadAgentRequestInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly modelId?: string;
}

export interface PromptThreadAgentInput extends PromptThreadAgentRequestInput {
  readonly userId: string;
  readonly isMcp?: boolean;
}

export type AgentThreadStatus = "idle" | "running" | "error";

export interface ReadFileToolArgs {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ExecCommandToolArgs {
  readonly command: string;
  readonly cwd?: string;
}

export interface AgentPromptResult {
  readonly ok: true;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly timestamp: number;
  readonly messageCount: number;
  readonly lastMessage: string | null;
}

export interface StoredAgentThread {
  readonly threadId: string;
  readonly userId: string;
  readonly title: string | null;
  readonly sandboxId: string | null;
  readonly isMcp: boolean;
  readonly status: AgentThreadStatus;
  readonly activity: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastPromptAt: number;
  readonly lastCompletedAt: number | null;
  readonly messageCount: number;
}

export interface StoredAgentThreadMessage {
  readonly sequence: number;
  readonly role: string;
  readonly timestamp: number | null;
  readonly rawJson: string;
}

export interface StoredAgentThreadContext {
  readonly thread: StoredAgentThread;
  readonly messages: readonly StoredAgentThreadMessage[];
}

export interface AgentThreadListItem {
  readonly threadId: string;
  readonly title: string | null;
  readonly sandboxId: string | null;
  readonly isMcp: boolean;
  readonly status: AgentThreadStatus;
  readonly activity: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastPromptAt: number;
  readonly lastCompletedAt: number | null;
  readonly messageCount: number;
}

export interface AgentPromptStreamError {
  readonly message: string;
  readonly kind: string;
  readonly timestamp: number;
  readonly traceId: string;
}

export interface PromptThreadAgentStream {
  readonly threadId: string;
  readonly sandboxId: string;
  readonly model: AgentModelOption;
  readonly events: AsyncIterable<AgentEvent>;
}

export interface AgentReadyEvent {
  readonly type: "ready";
  readonly threadId: string;
  readonly sandboxId: string;
  readonly model: AgentModelOption;
  readonly timestamp: number;
}

export interface AgentAssistantTextDeltaEvent {
  readonly type: "assistant_text_delta";
  readonly delta: string;
  readonly usage: Usage | null;
  readonly timestamp: number;
}

export interface AgentAssistantMessageEvent {
  readonly type: "assistant_message";
  readonly content: string;
  readonly usage: Usage;
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly errorMessage?: string;
  readonly timestamp: number;
}

export interface AgentDoneEvent {
  readonly type: "done";
  readonly timestamp: number;
}

export interface ReadFileToolCallStartEvent {
  readonly type: "tool_call_start";
  readonly toolType: "read_file";
  readonly toolCallId: string;
  readonly args: ReadFileToolArgs | null;
  readonly timestamp: number;
}

export interface ExecCommandToolCallStartEvent {
  readonly type: "tool_call_start";
  readonly toolType: "exec_command";
  readonly toolCallId: string;
  readonly args: ExecCommandToolArgs | null;
  readonly timestamp: number;
}

export interface UnknownToolCallStartEvent {
  readonly type: "tool_call_start";
  readonly toolType: "unknown";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
  readonly timestamp: number;
}

export interface ReadFileToolCallEndEvent {
  readonly type: "tool_call_end";
  readonly toolType: "read_file";
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: string;
  readonly details: SandboxReadFileResult | null;
  readonly timestamp: number;
}

export interface ExecCommandToolCallEndEvent {
  readonly type: "tool_call_end";
  readonly toolType: "exec_command";
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: string;
  readonly details: SandboxExecuteCommandResult | null;
  readonly timestamp: number;
}

export interface UnknownToolCallEndEvent {
  readonly type: "tool_call_end";
  readonly toolType: "unknown";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: string;
  readonly details: unknown;
  readonly timestamp: number;
  /**
   * When true, UI progress only — not a separate row in Convex (e.g. Box live tool traces).
   */
  readonly excludeFromPersistedCount?: boolean;
}

export type AgentToolCallStartEvent =
  | ReadFileToolCallStartEvent
  | ExecCommandToolCallStartEvent
  | UnknownToolCallStartEvent;

export type AgentToolCallEndEvent =
  | ReadFileToolCallEndEvent
  | ExecCommandToolCallEndEvent
  | UnknownToolCallEndEvent;

export type AgentPromptStreamEvent =
  | AgentReadyEvent
  | AgentAssistantTextDeltaEvent
  | AgentAssistantMessageEvent
  | AgentToolCallStartEvent
  | AgentToolCallEndEvent
  | AgentDoneEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isTextContent = (value: unknown): value is TextContent =>
  isRecord(value) && value.type === "text" && typeof value.text === "string";

const isImageContent = (value: unknown): value is ImageContent =>
  isRecord(value) &&
  value.type === "image" &&
  typeof value.data === "string" &&
  typeof value.mimeType === "string";

const isThinkingContent = (value: unknown): value is ThinkingContent =>
  isRecord(value) &&
  value.type === "thinking" &&
  typeof value.thinking === "string" &&
  (value.thinkingSignature === undefined || typeof value.thinkingSignature === "string") &&
  (value.redacted === undefined || typeof value.redacted === "boolean");

const isToolCall = (value: unknown): value is ToolCall =>
  isRecord(value) &&
  value.type === "toolCall" &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isRecord(value.arguments) &&
  (value.thoughtSignature === undefined || typeof value.thoughtSignature === "string");

const isUsage = (value: unknown): value is Usage =>
  isRecord(value) &&
  typeof value.input === "number" &&
  typeof value.output === "number" &&
  typeof value.cacheRead === "number" &&
  typeof value.cacheWrite === "number" &&
  typeof value.totalTokens === "number" &&
  isRecord(value.cost) &&
  typeof value.cost.input === "number" &&
  typeof value.cost.output === "number" &&
  typeof value.cost.cacheRead === "number" &&
  typeof value.cost.cacheWrite === "number" &&
  typeof value.cost.total === "number";

const stopReasons = new Set(["stop", "length", "toolUse", "error", "aborted"]);

export const isUserMessage = (value: unknown): value is UserMessage =>
  isRecord(value) &&
  value.role === "user" &&
  (typeof value.content === "string" ||
    (Array.isArray(value.content) &&
      value.content.every((content) => isTextContent(content) || isImageContent(content)))) &&
  typeof value.timestamp === "number";

export const isAssistantMessage = (value: unknown): value is AssistantMessage =>
  isRecord(value) &&
  value.role === "assistant" &&
  Array.isArray(value.content) &&
  value.content.every(
    (content) => isTextContent(content) || isThinkingContent(content) || isToolCall(content),
  ) &&
  typeof value.api === "string" &&
  typeof value.provider === "string" &&
  typeof value.model === "string" &&
  isUsage(value.usage) &&
  typeof value.stopReason === "string" &&
  stopReasons.has(value.stopReason) &&
  (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
  typeof value.timestamp === "number";

export const isToolResultMessage = (value: unknown): value is ToolResultMessage =>
  isRecord(value) &&
  value.role === "toolResult" &&
  typeof value.toolCallId === "string" &&
  typeof value.toolName === "string" &&
  Array.isArray(value.content) &&
  value.content.every((content) => isTextContent(content) || isImageContent(content)) &&
  typeof value.isError === "boolean" &&
  typeof value.timestamp === "number";

export const isPersistableAgentMessage = (value: unknown): value is Message =>
  isUserMessage(value) || isAssistantMessage(value) || isToolResultMessage(value);

export const isReadFileToolArgs = (value: unknown): value is ReadFileToolArgs => {
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0) {
    return false;
  }

  if (value.startLine !== undefined && !isPositiveInteger(value.startLine)) {
    return false;
  }

  if (value.endLine !== undefined && !isPositiveInteger(value.endLine)) {
    return false;
  }

  if (
    typeof value.startLine === "number" &&
    typeof value.endLine === "number" &&
    value.endLine < value.startLine
  ) {
    return false;
  }

  return true;
};

export const isExecCommandToolArgs = (value: unknown): value is ExecCommandToolArgs => {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.length === 0) {
    return false;
  }

  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    return false;
  }

  return true;
};

export const isSandboxReadFileResult = (value: unknown): value is SandboxReadFileResult => {
  if (
    !isRecord(value) ||
    typeof value.sandboxId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.content !== "string" ||
    !isPositiveInteger(value.lineStart) ||
    typeof value.lineEnd !== "number" ||
    value.lineEnd < value.lineStart - 1 ||
    !isNonNegativeInteger(value.totalLines)
  ) {
    return false;
  }

  if (value.requestedStartLine !== undefined && !isPositiveInteger(value.requestedStartLine)) {
    return false;
  }

  if (value.requestedEndLine !== undefined && !isPositiveInteger(value.requestedEndLine)) {
    return false;
  }

  return true;
};

export const isSandboxExecuteCommandResult = (
  value: unknown,
): value is SandboxExecuteCommandResult => {
  if (
    !isRecord(value) ||
    typeof value.sandboxId !== "string" ||
    typeof value.command !== "string" ||
    typeof value.exitCode !== "number" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.output !== "string"
  ) {
    return false;
  }

  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    return false;
  }

  if (value.computeMs !== undefined && typeof value.computeMs !== "number") {
    return false;
  }

  if (value.costUsd !== undefined && typeof value.costUsd !== "number") {
    return false;
  }

  return true;
};

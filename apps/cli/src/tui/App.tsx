import clipboard from "clipboardy";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useRef, useState } from "react";

declare global {
  var __BTCA_TUI_CONTEXT__:
    | {
        readonly baseUrl: string;
        readonly version: string;
        readonly provider: string;
        readonly model: string;
        readonly debug: boolean;
      }
    | undefined;
}

type Resource = {
  readonly name: string;
  readonly type: "git" | "local" | "npm";
};

type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "done" | "error";
  readonly summary: string | null;
};

type RunMetrics = {
  readonly priceUsd: number;
  readonly totalToolCalls: number;
  readonly outputTokens: number;
  readonly generationDurationMs: number | null;
  readonly outputTokensPerSecond: number | null;
};

type AssistantMessage = {
  readonly role: "assistant";
  readonly content: string;
  readonly reasoning: string;
  readonly reasoningStatus: "idle" | "running" | "done";
  readonly toolCalls: readonly ToolCall[];
  readonly canceled?: boolean;
  readonly runMetrics?: RunMetrics | null;
};

type Message =
  | {
      readonly role: "system";
      readonly content: string;
    }
  | {
      readonly role: "user";
      readonly content: string;
    }
  | AssistantMessage;

type ThreadSummary = {
  readonly threadId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: "idle" | "running" | "error";
  readonly activity: string | null;
  readonly workspaceDir: string | null;
  readonly modelId: string | null;
  readonly provider: string | null;
  readonly resourceNames: readonly string[];
  readonly messageCount: number;
};

type StoredThreadMessage = {
  readonly sequence: number;
  readonly role: "user" | "assistant" | "toolResult";
  readonly timestamp: number;
  readonly rawJson: string;
};

type ThreadDetail = ThreadSummary & {
  readonly messages: readonly StoredThreadMessage[];
};

type ThreadListResponse = {
  readonly ok: true;
  readonly threads: readonly ThreadSummary[];
};

type ThreadResponse = {
  readonly ok: true;
  readonly thread: ThreadDetail | null;
};

type ConfigResponse = {
  readonly ok: true;
  readonly model: {
    readonly provider: string;
    readonly model: string;
  };
};

type ResourcesResponse = {
  readonly ok: true;
  readonly resources: readonly Resource[];
};

type CommandItem = {
  readonly name: string;
  readonly description: string;
  readonly action: "clear" | "copy" | "copyAll" | "resume" | "quit";
};

type SuggestionItem = {
  readonly key: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly disabled?: boolean;
};

const tuiContext = globalThis.__BTCA_TUI_CONTEXT__;

if (!tuiContext) {
  throw new Error("Missing TUI bootstrap context.");
}

const colors = {
  accent: "#7AA2F7",
  dim: "#737AA2",
  error: "#F7768E",
  muted: "#565F89",
  success: "#73DACA",
  text: "#E8ECF8",
  warning: "#E0AF68",
} as const;

const defaultMessages: readonly Message[] = [
  {
    role: "system",
    content: "Welcome to btca. Ask with @resource mentions, or use /resume to reopen a thread.",
  },
];

const commands: readonly CommandItem[] = [
  { name: "/clear", description: "Clear the current chat", action: "clear" },
  { name: "/copy", description: "Copy your questions + last answer", action: "copy" },
  { name: "/copy-all", description: "Copy the full text transcript", action: "copyAll" },
  { name: "/resume", description: "Resume a previous thread", action: "resume" },
  { name: "/quit", description: "Exit the TUI", action: "quit" },
];

const mentionRegex = /(^|[^\w@])@(\S+)/g;
const trailingMentionPunctuationRegex = /[!?.,;:)\]}]+$/u;

const createAssistantMessage = (): AssistantMessage => ({
  role: "assistant",
  content: "",
  reasoning: "",
  reasoningStatus: "idle",
  toolCalls: [],
  runMetrics: null,
});

const splitMentionToken = (token: string) => {
  const normalized = token.replace(trailingMentionPunctuationRegex, "");
  return {
    normalized,
    suffix: token.slice(normalized.length),
  };
};

const extractMentionTokens = (input: string) => {
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(input)) !== null) {
    const token = match[2] ? splitMentionToken(match[2]).normalized.trim() : "";
    if (token) {
      mentions.push(token);
    }
  }

  return [...new Set(mentions)];
};

const stripMentionTokens = (input: string) =>
  input
    .replace(mentionRegex, (match, prefix, token) => {
      const { normalized, suffix } = splitMentionToken(String(token));
      return normalized ? `${String(prefix)}${suffix}` : match;
    })
    .replace(/\s+/g, " ")
    .trim();

const trimMessage = (value: string) => value.trim().replace(/\s+/g, " ");

const readResponseText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

const getResponseErrorMessage = (path: string, response: Response, bodyText: string) => {
  if (bodyText.trim().length > 0) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string" &&
        parsed.message.trim().length > 0
      ) {
        return trimMessage(parsed.message);
      }
    } catch {
      return trimMessage(bodyText);
    }
  }

  return `Server returned ${response.status} for ${path}.`;
};

const fetchJson = async <T,>(path: string, init?: RequestInit) => {
  const response = await fetch(`${tuiContext.baseUrl}${path}`, init);
  const bodyText = await readResponseText(response);

  if (!response.ok) {
    throw new Error(getResponseErrorMessage(path, response, bodyText));
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new Error(`Server returned an invalid JSON response for ${path}.`);
  }
};

const parseSseEvent = (rawEvent: string) => {
  const lines = rawEvent.split(/\r?\n/);
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const rawData = dataLines.join("\n");
  const data =
    rawData.length === 0
      ? null
      : (() => {
          try {
            return JSON.parse(rawData) as unknown;
          } catch {
            return rawData;
          }
        })();

  return {
    data,
    eventName,
  };
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n\n");
};

const extractReasoningContent = (content: unknown) => {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (
        isRecord(part) &&
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        part.thinking.trim().length > 0
      ) {
        return [part.thinking];
      }

      return [];
    })
    .join("\n\n");
};

const extractRunMetrics = (value: unknown): RunMetrics | null => {
  if (!isRecord(value) || !("runMetrics" in value) || !isRecord(value.runMetrics)) {
    return null;
  }

  const runMetrics = value.runMetrics;

  if (
    typeof runMetrics.priceUsd !== "number" ||
    typeof runMetrics.totalToolCalls !== "number" ||
    typeof runMetrics.outputTokens !== "number" ||
    !(
      runMetrics.generationDurationMs === null ||
      typeof runMetrics.generationDurationMs === "number"
    ) ||
    !(
      runMetrics.outputTokensPerSecond === null ||
      typeof runMetrics.outputTokensPerSecond === "number"
    )
  ) {
    return null;
  }

  return {
    priceUsd: runMetrics.priceUsd,
    totalToolCalls: runMetrics.totalToolCalls,
    outputTokens: runMetrics.outputTokens,
    generationDurationMs: runMetrics.generationDurationMs,
    outputTokensPerSecond: runMetrics.outputTokensPerSecond,
  };
};

const summarizeToolDetails = (value: unknown): string | null => {
  const parsed = parseJsonValue(value);

  if (!isRecord(parsed)) {
    return null;
  }

  const candidates = [
    parsed.path,
    parsed.cmd,
    parsed.command,
    parsed.query,
    parsed.q,
    parsed.location,
    parsed.url,
    parsed.name,
  ];

  const firstString = candidates.find((candidate) => typeof candidate === "string");
  if (typeof firstString !== "string" || firstString.trim().length === 0) {
    return null;
  }

  const normalized = firstString.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
};

const formatDateTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });

const formatThreadResources = (thread: ThreadSummary) =>
  thread.resourceNames.join(", ") || "no resources";

const formatThreadSuggestion = (thread: ThreadSummary): SuggestionItem => ({
  key: thread.threadId,
  primary: thread.activity?.trim() || "untitled",
  secondary: `${formatDateTime(thread.updatedAt)} · ${formatThreadResources(thread)}`,
});

const matchesThreadQuery = (thread: ThreadSummary, query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  const haystack = [
    thread.activity,
    formatThreadResources(thread),
    thread.workspaceDir,
    thread.provider,
    thread.modelId,
    thread.status,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalized);
};

const formatRunMetrics = (metrics: RunMetrics | null) => {
  if (!metrics) {
    return "";
  }

  const parts = [
    `$${metrics.priceUsd.toFixed(4)}`,
    `${metrics.totalToolCalls} tool${metrics.totalToolCalls === 1 ? "" : "s"}`,
    `${metrics.outputTokens} tok`,
  ];

  if (metrics.outputTokensPerSecond !== null) {
    parts.push(`${metrics.outputTokensPerSecond.toFixed(1)} tok/s`);
  }

  if (metrics.generationDurationMs !== null) {
    parts.push(`${(metrics.generationDurationMs / 1000).toFixed(1)}s`);
  }

  return parts.join(" · ");
};

const getMessageKey = (message: Message, index: number) => {
  if (message.role === "assistant") {
    return `assistant:${index}:${message.content.slice(0, 24)}:${message.toolCalls.length}`;
  }

  return `${message.role}:${index}:${message.content.slice(0, 24)}`;
};

const resolveConfiguredResourceName = (token: string, resources: readonly Resource[]) => {
  const normalized = token.toLowerCase();
  const exact = resources.find((resource) => resource.name.toLowerCase() === normalized);
  if (exact) {
    return exact.name;
  }

  const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  const alternate = resources.find((resource) => resource.name.toLowerCase() === withoutAt);
  return alternate?.name ?? null;
};

const isHttpsReference = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const isNpmReference = (value: string) => {
  if (value.startsWith("npm:")) {
    return value.length > 4 && !/\s/.test(value);
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return false;
    }

    return (
      ["npmjs.com", "www.npmjs.com"].includes(parsed.hostname) &&
      parsed.pathname.includes("/package/")
    );
  } catch {
    return false;
  }
};

const resolveResourceReference = (token: string, resources: readonly Resource[]) => {
  const normalized = token.startsWith("@") ? token.slice(1) : token;
  if (!normalized) {
    return null;
  }

  const configured = resolveConfiguredResourceName(normalized, resources);
  if (configured) {
    return configured;
  }

  return isHttpsReference(normalized) || isNpmReference(normalized) ? normalized : null;
};

const parseThreadMessages = (thread: ThreadDetail | null) => {
  if (!thread) {
    return {
      lastRunMetrics: null,
      messages: defaultMessages,
    } as const;
  }

  const nextMessages: Message[] = [];
  let lastRunMetrics: RunMetrics | null = null;

  for (const storedMessage of thread.messages) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(storedMessage.rawJson);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || !("role" in parsed)) {
      continue;
    }

    if (parsed.role === "user") {
      const content =
        "content" in parsed
          ? typeof parsed.content === "string"
            ? parsed.content
            : extractTextContent(parsed.content)
          : "";

      if (content) {
        nextMessages.push({ role: "user", content });
      }
      continue;
    }

    if (parsed.role === "assistant") {
      const content = "content" in parsed ? extractTextContent(parsed.content) : "";
      const reasoning = "content" in parsed ? extractReasoningContent(parsed.content) : "";
      const runMetrics = extractRunMetrics(parsed);

      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content,
        reasoning,
        reasoningStatus: reasoning ? "done" : "idle",
        toolCalls: [],
        runMetrics,
      };

      nextMessages.push(assistantMessage);

      if (runMetrics) {
        lastRunMetrics = runMetrics;
      }
      continue;
    }

    if (parsed.role === "toolResult") {
      const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "tool";
      const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : toolName;
      const summary = "content" in parsed ? extractTextContent(parsed.content) : "";
      const isError = "isError" in parsed && parsed.isError === true;
      const previous = nextMessages.at(-1);

      if (previous?.role === "assistant") {
        nextMessages[nextMessages.length - 1] = {
          ...previous,
          toolCalls: [
            ...previous.toolCalls,
            {
              id: toolCallId,
              name: toolName,
              status: isError ? "error" : "done",
              summary: summary || null,
            },
          ],
        };
      }
    }
  }

  return {
    lastRunMetrics,
    messages: nextMessages.length > 0 ? nextMessages : defaultMessages,
  } as const;
};

const getLastAssistantText = (
  messages: readonly Message[],
  currentAssistant: AssistantMessage | null,
) => {
  if (currentAssistant?.content.trim()) {
    return currentAssistant.content.trim();
  }

  const assistantMessages = messages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const lastAssistant = assistantMessages.at(-1);
  return lastAssistant?.content.trim() || null;
};

const formatTranscriptLine = (role: "user" | "assistant", content: string) => {
  const label = role === "user" ? "You" : "Btca";
  return `${label}: ${content.trim()}`;
};

const buildCopyTranscript = (
  messages: readonly Message[],
  currentAssistant: AssistantMessage | null,
  mode: "latest" | "all",
) => {
  const userLines = messages
    .filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
    .map((message) => formatTranscriptLine("user", message.content))
    .filter((line) => line.length > 0);

  if (mode === "latest") {
    const lastAssistantText = getLastAssistantText(messages, currentAssistant);
    if (!lastAssistantText) {
      return null;
    }

    return [...userLines, formatTranscriptLine("assistant", lastAssistantText)].join("\n\n");
  }

  const transcriptLines = messages
    .flatMap((message) => {
      if (message.role === "user") {
        return message.content.trim() ? [formatTranscriptLine("user", message.content)] : [];
      }

      if (message.role === "assistant") {
        return message.content.trim() ? [formatTranscriptLine("assistant", message.content)] : [];
      }

      return [];
    })
    .filter((line) => line.length > 0);

  if (currentAssistant?.content.trim()) {
    transcriptLines.push(formatTranscriptLine("assistant", currentAssistant.content));
  }

  return transcriptLines.length > 0 ? transcriptLines.join("\n\n") : null;
};

const Header = ({ model, provider }: { model: string; provider: string }) => (
  <Box>
    <Text bold color={colors.accent}>
      {"btca"}
    </Text>
    <Text color={colors.muted}>{`  ${provider}/${model}`}</Text>
  </Box>
);

const UserMessageRow = ({ content }: { content: string }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold color={colors.accent}>
      {"you"}
    </Text>
    <Text color={colors.text}>{content}</Text>
  </Box>
);

const SystemMessageRow = ({ content }: { content: string }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text color={colors.dim}>{content}</Text>
  </Box>
);

const AssistantMessageRow = ({
  isActive,
  message,
}: {
  isActive: boolean;
  message: AssistantMessage;
}) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={colors.accent}>
        {"btca"}
      </Text>
      {message.reasoningStatus === "running" ? (
        <Text color={colors.dim}>{"  thinking..."}</Text>
      ) : null}
      {message.toolCalls.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {message.toolCalls.map((toolCall) => (
            <Text
              key={toolCall.id}
              color={
                toolCall.status === "error"
                  ? colors.error
                  : toolCall.status === "running"
                    ? colors.warning
                    : colors.dim
              }
            >
              {`  ${toolCall.status === "running" ? "◌" : toolCall.status === "error" ? "✕" : "●"} ${toolCall.name}${toolCall.summary ? `  ${toolCall.summary}` : ""}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {message.content ? (
        <Box marginTop={1}>
          <Text color={colors.text}>{message.content}</Text>
        </Box>
      ) : null}
      {isActive &&
      !message.content &&
      message.toolCalls.length === 0 &&
      message.reasoning.length === 0 ? (
        <Text color={colors.dim}>{"..."}</Text>
      ) : null}
      {message.canceled ? <Text color={colors.warning}>{"canceled"}</Text> : null}
    </Box>
  );
};

const TranscriptRow = ({ isActive = false, message }: { isActive?: boolean; message: Message }) => {
  if (message.role === "system") {
    return <SystemMessageRow content={message.content} />;
  }

  if (message.role === "user") {
    return <UserMessageRow content={message.content} />;
  }

  return <AssistantMessageRow isActive={isActive} message={message} />;
};

const Suggestions = ({
  items,
  label,
  selectedIndex,
}: {
  items: readonly SuggestionItem[];
  label: string;
  selectedIndex: number;
}) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.dim}>{label}</Text>
      {items.map((item, index) => (
        <Box key={item.key} flexDirection="column">
          <Text
            color={
              item.disabled ? colors.dim : index === selectedIndex ? colors.accent : colors.text
            }
          >
            {`${index === selectedIndex && !item.disabled ? "›" : " "} ${item.primary}`}
          </Text>
          {item.secondary ? <Text color={colors.dim}>{`  ${item.secondary}`}</Text> : null}
        </Box>
      ))}
    </Box>
  );
};

const App = () => {
  const { exit } = useApp();

  const [provider, setProvider] = useState(tuiContext.provider);
  const [model, setModel] = useState(tuiContext.model);
  const [resources, setResources] = useState<readonly Resource[]>([]);
  const [messages, setMessages] = useState<readonly Message[]>(defaultMessages);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadResources, setThreadResources] = useState<readonly string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [threads, setThreads] = useState<readonly ThreadSummary[]>([]);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);
  const [resumeLoadError, setResumeLoadError] = useState<string | null>(null);
  const [selectedThreadIndex, setSelectedThreadIndex] = useState(0);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [inputRenderKey, setInputRenderKey] = useState(0);
  const [currentAssistant, setCurrentAssistant] = useState<AssistantMessage | null>(null);
  const [lastRunMetrics, setLastRunMetrics] = useState<RunMetrics | null>(null);
  const [transcriptKey, setTranscriptKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentAssistantRef = useRef<AssistantMessage | null>(null);

  const commandMatches = useMemo(() => {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) {
      return [];
    }

    return commands.filter((command) => command.name.startsWith(trimmed.toLowerCase()));
  }, [input]);

  const currentMentionToken = useMemo(() => {
    const match = input.match(/(^|(?<=\s))@[^\s]*$/);
    return match?.[0] ?? null;
  }, [input]);

  const mentionMatches = useMemo(() => {
    if (!currentMentionToken) {
      return [];
    }

    const normalized = currentMentionToken.slice(1).toLowerCase();
    return resources
      .filter((resource) => resource.name.toLowerCase().includes(normalized))
      .map((resource) => resource.name);
  }, [currentMentionToken, resources]);

  const resumeQuery = useMemo(() => {
    const trimmed = input.trimStart();
    if (trimmed === "/resume") {
      return "";
    }

    if (trimmed.startsWith("/resume ")) {
      return trimmed.slice("/resume".length).trim();
    }

    return null;
  }, [input]);

  const isResumeCommand = resumeQuery !== null;

  const resumeMatches = useMemo(() => {
    if (!isResumeCommand) {
      return [];
    }

    return threads.filter((thread) => matchesThreadQuery(thread, resumeQuery)).slice(0, 8);
  }, [isResumeCommand, resumeQuery, threads]);

  const activeSuggestions = useMemo(() => {
    if (isResumeCommand) {
      if (resumeLoadError) {
        return {
          items: [{ key: "resume-error", primary: resumeLoadError, disabled: true }],
          label: "Resume thread",
          selectedIndex: 0,
        } as const;
      }

      if (isLoadingThreads && threads.length === 0) {
        return {
          items: [{ key: "resume-loading", primary: "Loading saved threads...", disabled: true }],
          label: "Resume thread",
          selectedIndex: 0,
        } as const;
      }

      if (threads.length === 0) {
        return {
          items: [{ key: "resume-empty", primary: "No saved threads yet.", disabled: true }],
          label: "Resume thread",
          selectedIndex: 0,
        } as const;
      }

      if (resumeMatches.length === 0) {
        return {
          items: [
            {
              key: "resume-no-match",
              primary: "No saved threads match that search.",
              disabled: true,
            },
          ],
          label: "Resume thread",
          selectedIndex: 0,
        } as const;
      }

      return {
        items: resumeMatches.map(formatThreadSuggestion),
        label: "Resume thread",
        selectedIndex: selectedThreadIndex,
      } as const;
    }

    if (commandMatches.length > 0) {
      return {
        items: commandMatches.map((command) => ({
          key: command.name,
          primary: command.name,
          secondary: command.description,
        })),
        label: "Commands",
        selectedIndex: selectedCommandIndex,
      } as const;
    }

    if (mentionMatches.length > 0) {
      return {
        items: mentionMatches.map((name) => ({
          key: name,
          primary: `@${name}`,
        })),
        label: "Resources",
        selectedIndex: selectedMentionIndex,
      } as const;
    }

    return { items: [], label: "", selectedIndex: 0 } as const;
  }, [
    commandMatches,
    isLoadingThreads,
    isResumeCommand,
    mentionMatches,
    resumeLoadError,
    resumeMatches,
    selectedCommandIndex,
    selectedMentionIndex,
    selectedThreadIndex,
    threads.length,
  ]);

  const transcriptItems = useMemo(
    () => messages.map((message, index) => ({ id: getMessageKey(message, index), message })),
    [messages],
  );

  const resetTranscript = (nextMessages: readonly Message[], nextMetrics: RunMetrics | null) => {
    currentAssistantRef.current = null;
    setCurrentAssistant(null);
    setMessages(nextMessages);
    setLastRunMetrics(nextMetrics);
    setTranscriptKey((current) => current + 1);
  };

  const addSystemMessage = (content: string) =>
    setMessages((current) => [...current, { role: "system", content }]);

  const applyMentionCompletion = (nextMention: string) => {
    setInput((current) => current.replace(/(^|(?<=\s))@[^\s]*$/, `@${nextMention} `));
    setInputRenderKey((current) => current + 1);
  };

  const updateCurrentAssistant = (updater: (current: AssistantMessage) => AssistantMessage) => {
    const next = updater(currentAssistantRef.current ?? createAssistantMessage());
    currentAssistantRef.current = next;
    setCurrentAssistant(next);
  };

  const commitCurrentAssistant = () => {
    const assistant = currentAssistantRef.current;
    if (!assistant) {
      return;
    }

    setMessages((current) => [...current, assistant]);
    if (assistant.runMetrics) {
      setLastRunMetrics(assistant.runMetrics);
    }
    currentAssistantRef.current = null;
    setCurrentAssistant(null);
  };

  const refreshThreads = async () => {
    const response = await fetchJson<ThreadListResponse>("/threads");
    setThreads(response.threads);
    setSelectedThreadIndex(0);
  };

  const executeCommand = async (command: CommandItem) => {
    setInput("");

    if (command.action === "clear") {
      setThreadId(null);
      setThreadResources([]);
      resetTranscript(defaultMessages, null);
      return;
    }

    if (command.action === "copy" || command.action === "copyAll") {
      const transcript = buildCopyTranscript(
        messages,
        currentAssistantRef.current,
        command.action === "copy" ? "latest" : "all",
      );

      if (!transcript) {
        addSystemMessage(
          command.action === "copy"
            ? "Nothing to copy yet. Ask a question first."
            : "Nothing to copy yet.",
        );
        return;
      }

      try {
        await clipboard.write(transcript);
        addSystemMessage(
          command.action === "copy"
            ? "Copied your questions and the latest btca reply."
            : "Copied the full text transcript.",
        );
      } catch (error) {
        addSystemMessage(error instanceof Error ? error.message : "Failed to copy the transcript.");
      }
      return;
    }

    if (command.action === "resume") {
      setInput("/resume ");
      setInputRenderKey((current) => current + 1);
      setSelectedThreadIndex(0);
      return;
    }

    exit();
  };

  const loadThread = async (nextThreadId: string) => {
    const response = await fetchJson<ThreadResponse>(
      `/threads/${encodeURIComponent(nextThreadId)}`,
    );
    if (!response.thread) {
      throw new Error("That thread no longer exists.");
    }

    const parsedThread = parseThreadMessages(response.thread);
    setThreadId(response.thread.threadId);
    setThreadResources(response.thread.resourceNames);
    setProvider(response.thread.provider ?? provider);
    setModel(response.thread.modelId ?? model);
    resetTranscript(parsedThread.messages, parsedThread.lastRunMetrics);
    setInput("");
  };

  const submit = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isStreaming) {
      return;
    }

    if (isResumeCommand) {
      if (isLoadingThreads) {
        return;
      }

      const thread = resumeMatches[selectedThreadIndex] ?? resumeMatches[0];
      if (!thread) {
        addSystemMessage(
          resumeLoadError ??
            (threads.length === 0
              ? "No saved threads yet."
              : "No saved threads match that search."),
        );
        return;
      }

      try {
        await loadThread(thread.threadId);
      } catch (error) {
        addSystemMessage(error instanceof Error ? error.message : "Failed to resume thread.");
      }
      return;
    }

    if (commandMatches.length > 0 && trimmedInput.startsWith("/")) {
      const command = commandMatches[selectedCommandIndex] ?? commandMatches[0];
      if (command) {
        await executeCommand(command);
      }
      return;
    }

    const mentioned = extractMentionTokens(trimmedInput);
    const resolvedMentioned = mentioned
      .map((token) => resolveResourceReference(token, resources))
      .filter((value): value is string => value !== null);
    const invalidMention = mentioned.find(
      (token) => resolveResourceReference(token, resources) === null,
    );

    if (invalidMention) {
      addSystemMessage(`Unknown resource: @${invalidMention}`);
      return;
    }

    const question = stripMentionTokens(trimmedInput);
    const resourceNames = [...new Set([...threadResources, ...resolvedMentioned])];

    if (!question) {
      addSystemMessage("Add a question after the resource mention.");
      return;
    }

    if (resourceNames.length === 0) {
      addSystemMessage("Start with @resource so btca knows what context to load.");
      return;
    }

    setInput("");
    setThreadResources(resourceNames);
    setMessages((current) => [...current, { role: "user", content: trimmedInput }]);
    setLastRunMetrics(null);
    currentAssistantRef.current = createAssistantMessage();
    setCurrentAssistant(currentAssistantRef.current);
    setIsStreaming(true);
    setCancelPending(false);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch(`${tuiContext.baseUrl}/ask`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          question,
          quiet: true,
          resourceNames,
          threadId: threadId ?? undefined,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const bodyText = await readResponseText(response);
        throw new Error(getResponseErrorMessage("/ask", response, bodyText));
      }

      if (response.body === null) {
        throw new Error("Server returned an empty response body for /ask.");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });

        while (true) {
          const boundaryIndex = buffer.indexOf("\n\n");
          if (boundaryIndex === -1) {
            break;
          }

          const rawEvent = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);

          if (!rawEvent) {
            continue;
          }

          const parsed = parseSseEvent(rawEvent);

          if (parsed.eventName === "start" && parsed.data && typeof parsed.data === "object") {
            const record = parsed.data as Record<string, unknown>;
            if (typeof record.threadId === "string") {
              setThreadId(record.threadId);
            }
            if (typeof record.provider === "string") {
              setProvider(record.provider);
            }
            if (typeof record.modelId === "string") {
              setModel(record.modelId);
            }
            continue;
          }

          if (parsed.eventName === "done") {
            commitCurrentAssistant();
            continue;
          }

          if (parsed.eventName === "error" && parsed.data && typeof parsed.data === "object") {
            const record = parsed.data as Record<string, unknown>;
            throw new Error(
              typeof record.message === "string" ? record.message : "The agent request failed.",
            );
          }

          if (!parsed.data || typeof parsed.data !== "object" || !("event" in parsed.data)) {
            continue;
          }

          const outerEvent = (parsed.data as { readonly event: unknown }).event;
          if (!outerEvent || typeof outerEvent !== "object" || !("type" in outerEvent)) {
            continue;
          }

          if (outerEvent.type === "message_update") {
            const assistantMessageEvent =
              "assistantMessageEvent" in outerEvent ? outerEvent.assistantMessageEvent : null;

            if (
              assistantMessageEvent &&
              typeof assistantMessageEvent === "object" &&
              "type" in assistantMessageEvent
            ) {
              if (
                assistantMessageEvent.type === "text_delta" &&
                "delta" in assistantMessageEvent &&
                typeof assistantMessageEvent.delta === "string"
              ) {
                updateCurrentAssistant((current) => ({
                  ...current,
                  content: current.content + assistantMessageEvent.delta,
                }));
              }

              if (
                assistantMessageEvent.type === "thinking_start" ||
                assistantMessageEvent.type === "thinking_end"
              ) {
                updateCurrentAssistant((current) => ({
                  ...current,
                  reasoningStatus:
                    assistantMessageEvent.type === "thinking_start" ? "running" : "done",
                }));
              }

              if (
                assistantMessageEvent.type === "thinking_delta" &&
                "delta" in assistantMessageEvent &&
                typeof assistantMessageEvent.delta === "string"
              ) {
                updateCurrentAssistant((current) => ({
                  ...current,
                  reasoning: current.reasoning + assistantMessageEvent.delta,
                  reasoningStatus: "running",
                }));
              }

              const toolCall =
                "toolCall" in assistantMessageEvent &&
                isRecord(assistantMessageEvent.toolCall) &&
                typeof assistantMessageEvent.toolCall.name === "string"
                  ? {
                      args:
                        "arguments" in assistantMessageEvent.toolCall
                          ? assistantMessageEvent.toolCall.arguments
                          : null,
                      name: assistantMessageEvent.toolCall.name,
                    }
                  : null;

              if (assistantMessageEvent.type === "toolcall_end" && toolCall) {
                updateCurrentAssistant((current) => {
                  const existingIndex = current.toolCalls.findIndex(
                    (currentToolCall) =>
                      currentToolCall.name === toolCall.name &&
                      currentToolCall.status === "running",
                  );

                  if (existingIndex === -1) {
                    return {
                      ...current,
                      toolCalls: [
                        ...current.toolCalls,
                        {
                          id: `${toolCall.name}:${current.toolCalls.length}`,
                          name: toolCall.name,
                          status: "done",
                          summary: summarizeToolDetails(toolCall.args),
                        },
                      ],
                    };
                  }

                  return {
                    ...current,
                    toolCalls: current.toolCalls.map((toolCall, index) =>
                      index === existingIndex ? { ...toolCall, status: "done" } : toolCall,
                    ),
                  };
                });
              }
            }

            continue;
          }

          const toolExecutionStart =
            outerEvent.type === "tool_execution_start" &&
            "toolCallId" in outerEvent &&
            typeof outerEvent.toolCallId === "string" &&
            "toolName" in outerEvent &&
            typeof outerEvent.toolName === "string"
              ? {
                  args: "args" in outerEvent ? outerEvent.args : null,
                  toolCallId: outerEvent.toolCallId,
                  toolName: outerEvent.toolName,
                }
              : null;

          if (toolExecutionStart) {
            updateCurrentAssistant((current) => ({
              ...current,
              toolCalls: [
                ...current.toolCalls,
                {
                  id: toolExecutionStart.toolCallId,
                  name: toolExecutionStart.toolName,
                  status: "running",
                  summary: summarizeToolDetails(toolExecutionStart.args),
                },
              ],
            }));
            continue;
          }

          const toolExecutionEnd =
            outerEvent.type === "tool_execution_end" &&
            "toolCallId" in outerEvent &&
            typeof outerEvent.toolCallId === "string"
              ? outerEvent
              : null;

          if (toolExecutionEnd) {
            updateCurrentAssistant((current) => ({
              ...current,
              toolCalls: current.toolCalls.map((toolCall) =>
                toolCall.id === toolExecutionEnd.toolCallId
                  ? {
                      ...toolCall,
                      status:
                        "isError" in toolExecutionEnd && toolExecutionEnd.isError === true
                          ? "error"
                          : "done",
                      summary:
                        toolCall.summary ??
                        summarizeToolDetails(
                          "result" in toolExecutionEnd && isRecord(toolExecutionEnd.result)
                            ? toolExecutionEnd.result.details
                            : null,
                        ),
                    }
                  : toolCall,
              ),
            }));
            continue;
          }

          const assistantEndMessage =
            outerEvent.type === "message_end" &&
            "message" in outerEvent &&
            isRecord(outerEvent.message) &&
            outerEvent.message.role === "assistant"
              ? outerEvent.message
              : null;

          if (assistantEndMessage) {
            if ("stopReason" in assistantEndMessage && assistantEndMessage.stopReason === "error") {
              throw new Error(
                "errorMessage" in assistantEndMessage &&
                  typeof assistantEndMessage.errorMessage === "string"
                  ? assistantEndMessage.errorMessage
                  : "The model request failed.",
              );
            }

            const finalContent =
              "content" in assistantEndMessage ? assistantEndMessage.content : null;
            const finalReasoning = extractReasoningContent(finalContent);

            updateCurrentAssistant((current) => ({
              ...current,
              content: extractTextContent(finalContent),
              reasoning: finalReasoning || current.reasoning,
              reasoningStatus: finalReasoning ? "done" : current.reasoningStatus,
              runMetrics: extractRunMetrics(assistantEndMessage) ?? current.runMetrics ?? null,
            }));
            continue;
          }

          if (outerEvent.type === "agent_end") {
            const runMetrics = extractRunMetrics(outerEvent);
            if (runMetrics) {
              updateCurrentAssistant((current) => ({
                ...current,
                runMetrics,
              }));
            }
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        updateCurrentAssistant((current) => ({
          ...current,
          canceled: true,
        }));
        commitCurrentAssistant();
        addSystemMessage("Canceled the current response.");
      } else {
        commitCurrentAssistant();
        addSystemMessage(error instanceof Error ? error.message : "The agent request failed.");
      }
    } finally {
      abortControllerRef.current = null;
      setCancelPending(false);
      setIsStreaming(false);
      commitCurrentAssistant();
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [configResponse, resourcesResponse] = await Promise.all([
          fetchJson<ConfigResponse>("/config"),
          fetchJson<ResourcesResponse>("/resources"),
        ]);

        setProvider(configResponse.model.provider);
        setModel(configResponse.model.model);
        setResources(resourcesResponse.resources);
      } catch (error) {
        addSystemMessage(
          error instanceof Error ? error.message : "Failed to load initial TUI data.",
        );
      }
    })();
  }, []);

  useEffect(() => {
    setSelectedCommandIndex((current) =>
      commandMatches.length === 0 ? 0 : Math.min(current, commandMatches.length - 1),
    );
  }, [commandMatches.length]);

  useEffect(() => {
    setSelectedMentionIndex((current) =>
      mentionMatches.length === 0 ? 0 : Math.min(current, mentionMatches.length - 1),
    );
  }, [mentionMatches.length]);

  useEffect(() => {
    setSelectedThreadIndex((current) =>
      resumeMatches.length === 0 ? 0 : Math.min(current, resumeMatches.length - 1),
    );
  }, [resumeMatches.length]);

  useEffect(() => {
    if (!isResumeCommand) {
      setIsLoadingThreads(false);
      setResumeLoadError(null);
      return;
    }

    let canceled = false;
    setIsLoadingThreads(true);
    setResumeLoadError(null);

    void refreshThreads()
      .catch((error) => {
        if (canceled) {
          return;
        }

        setResumeLoadError(
          error instanceof Error ? error.message : "Failed to load saved threads.",
        );
      })
      .finally(() => {
        if (!canceled) {
          setIsLoadingThreads(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [isResumeCommand]);

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === "q") {
      abortControllerRef.current?.abort();
      exit();
      return;
    }

    if (isStreaming && key.escape) {
      if (cancelPending) {
        abortControllerRef.current?.abort();
      } else {
        setCancelPending(true);
      }
      return;
    }

    if (isResumeCommand && key.escape) {
      setInput("");
      setInputRenderKey((current) => current + 1);
      setSelectedThreadIndex(0);
      return;
    }

    if (!isStreaming && key.escape) {
      setCancelPending(false);
      return;
    }

    if (isResumeCommand) {
      if (key.upArrow) {
        setSelectedThreadIndex((current) =>
          resumeMatches.length === 0
            ? 0
            : (current - 1 + resumeMatches.length) % resumeMatches.length,
        );
      }

      if (key.downArrow) {
        setSelectedThreadIndex((current) =>
          resumeMatches.length === 0 ? 0 : (current + 1) % resumeMatches.length,
        );
      }

      return;
    }

    if (commandMatches.length > 0) {
      if (key.upArrow) {
        setSelectedCommandIndex(
          (current) => (current - 1 + commandMatches.length) % commandMatches.length,
        );
      }

      if (key.downArrow) {
        setSelectedCommandIndex((current) => (current + 1) % commandMatches.length);
      }

      return;
    }

    if (mentionMatches.length > 0) {
      if (key.upArrow) {
        setSelectedMentionIndex(
          (current) => (current - 1 + mentionMatches.length) % mentionMatches.length,
        );
      }

      if (key.downArrow) {
        setSelectedMentionIndex((current) => (current + 1) % mentionMatches.length);
      }

      if (key.tab) {
        const nextMention = mentionMatches[selectedMentionIndex] ?? mentionMatches[0];
        if (nextMention) {
          applyMentionCompletion(nextMention);
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Header provider={provider} model={model} />

      <Box flexDirection="column" marginTop={1}>
        <Static key={transcriptKey} items={transcriptItems}>
          {(item) => <TranscriptRow key={item.id} message={item.message} />}
        </Static>
        {currentAssistant ? (
          <TranscriptRow isActive={isStreaming} message={currentAssistant} />
        ) : null}
      </Box>

      <Box marginTop={2}>
        <Text color={colors.accent}>{"❯ "}</Text>
        <TextInput
          key={inputRenderKey}
          focus
          placeholder="@resource question... or / for commands"
          showCursor
          value={input}
          onChange={setInput}
          onSubmit={() => {
            if (isResumeCommand) {
              void submit();
              return;
            }

            if (mentionMatches.length > 0) {
              const nextMention = mentionMatches[selectedMentionIndex] ?? mentionMatches[0];
              if (nextMention) {
                applyMentionCompletion(nextMention);
              }
              return;
            }

            if (commandMatches.length > 0) {
              const command = commandMatches[selectedCommandIndex] ?? commandMatches[0];
              if (command) {
                void executeCommand(command);
              }
              return;
            }

            void submit();
          }}
        />
      </Box>

      {activeSuggestions.items.length > 0 ? (
        <Suggestions
          items={activeSuggestions.items}
          label={activeSuggestions.label}
          selectedIndex={activeSuggestions.selectedIndex}
        />
      ) : null}

      <Box justifyContent="space-between" marginTop={1}>
        <Text color={colors.muted}>
          {isStreaming
            ? cancelPending
              ? "esc again to cancel"
              : "streaming..."
            : isResumeCommand
              ? "↑↓ select thread · enter resume · esc close"
              : lastRunMetrics
                ? formatRunMetrics(lastRunMetrics)
                : "@ mention · / commands · ^q quit"}
        </Text>
        <Text color={colors.muted}>
          {threadResources.length > 0
            ? threadResources.map((resource) => `@${resource}`).join(" ")
            : `v${tuiContext.version}`}
        </Text>
      </Box>
    </Box>
  );
};

export const runTui = async () => {
  const instance = render(<App />);
  await instance.waitUntilExit();
};

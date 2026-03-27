import { Box, render, Text, useApp, useInput, useStdout } from "ink";
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

type AssistantChunk =
  | {
      readonly type: "tool";
      readonly toolName: string;
    }
  | {
      readonly type: "text";
      readonly text: string;
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
  | {
      readonly role: "assistant";
      readonly chunks: readonly AssistantChunk[];
      readonly canceled?: boolean;
    };

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
  readonly action: "clear" | "resume" | "quit";
};

const tuiContext = globalThis.__BTCA_TUI_CONTEXT__;

if (!tuiContext) {
  throw new Error("Missing TUI bootstrap context.");
}

const colors = {
  accent: "#4783eb",
  border: "#404040",
  dim: "#a3a3a3",
  error: "#ef4444",
  muted: "#737373",
  success: "#22c55e",
  text: "#fafafa",
  warning: "#facc15",
} as const;

const defaultMessages: readonly Message[] = [
  {
    role: "system",
    content: "Welcome to btca. Ask with @resource mentions, or use /resume to reopen a thread.",
  },
];

const commands: readonly CommandItem[] = [
  { name: "/clear", description: "Clear the current chat", action: "clear" },
  { name: "/resume", description: "Resume a previous thread", action: "resume" },
  { name: "/quit", description: "Exit the TUI", action: "quit" },
];

const mentionRegex = /(^|[^\w@])@(\S+)/g;
const trailingMentionPunctuationRegex = /[!?.,;:)\]}]+$/u;

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

const fetchJson = async <T,>(path: string, init?: RequestInit) => {
  const response = await fetch(`${tuiContext.baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`Server returned ${response.status} for ${path}`);
  }

  return (await response.json()) as T;
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

const formatDateTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });

const extractContentText = (content: unknown): string => {
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

const parseThreadMessages = (thread: ThreadDetail | null): readonly Message[] => {
  if (!thread) {
    return defaultMessages;
  }

  const nextMessages: Message[] = [];

  for (const storedMessage of thread.messages) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(storedMessage.rawJson);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || !("role" in parsed)) {
      continue;
    }

    if (parsed.role === "user") {
      const content =
        "content" in parsed
          ? typeof parsed.content === "string"
            ? parsed.content
            : extractContentText(parsed.content)
          : "";

      if (content) {
        nextMessages.push({ role: "user", content });
      }
      continue;
    }

    if (parsed.role === "assistant") {
      const text = "content" in parsed ? extractContentText(parsed.content) : "";
      if (text) {
        nextMessages.push({
          role: "assistant",
          chunks: [{ type: "text", text }],
        });
      }
    }
  }

  return nextMessages.length > 0 ? nextMessages : defaultMessages;
};

const estimateLines = (value: string, width: number) => {
  if (value.length === 0) {
    return 1;
  }

  return value
    .split("\n")
    .map((line) => Math.max(1, Math.ceil(line.length / Math.max(width, 1))))
    .reduce((sum, count) => sum + count, 0);
};

const getAssistantText = (message: Extract<Message, { role: "assistant" }>) =>
  message.chunks
    .filter((chunk): chunk is Extract<AssistantChunk, { type: "text" }> => chunk.type === "text")
    .map((chunk) => chunk.text)
    .join("");

const summarizeAssistantTools = (message: Extract<Message, { role: "assistant" }>) => {
  const counts = new Map<string, number>();

  for (const chunk of message.chunks) {
    if (chunk.type !== "tool") {
      continue;
    }

    counts.set(chunk.toolName, (counts.get(chunk.toolName) ?? 0) + 1);
  }

  return [...counts.entries()].map(([name, count]) => `${name} x${count}`);
};

const Header = ({ model, provider }: { model: string; provider: string }) => (
  <Box borderStyle="round" borderColor={colors.border} paddingX={1} justifyContent="space-between">
    <Text>
      <Text color={colors.accent}>{"◆"}</Text>
      <Text color={colors.text}>{" btca"}</Text>
      <Text color={colors.dim}>{" - local research tui"}</Text>
    </Text>
    <Text color={colors.muted}>{`${provider}/${model}`}</Text>
  </Box>
);

const MessageRow = ({ message }: { message: Message }) => {
  if (message.role === "system") {
    return (
      <Box borderStyle="round" borderColor={colors.border} paddingX={1}>
        <Text color={colors.dim}>{message.content}</Text>
      </Box>
    );
  }

  if (message.role === "user") {
    return (
      <Box borderStyle="round" borderColor={colors.border} paddingX={1}>
        <Text color={colors.text}>
          <Text color={colors.accent}>{"You: "}</Text>
          {message.content}
        </Text>
      </Box>
    );
  }

  const tools = summarizeAssistantTools(message);
  const text = getAssistantText(message);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text color={colors.text}>
        <Text color={colors.accent}>{"btca: "}</Text>
        {text || (tools.length > 0 ? "Working..." : "")}
      </Text>
      {tools.length > 0 ? <Text color={colors.dim}>{`Tools: ${tools.join(" | ")}`}</Text> : null}
      {message.canceled ? <Text color={colors.warning}>{"Canceled"}</Text> : null}
    </Box>
  );
};

const ResumeList = ({
  selectedIndex,
  threads,
}: {
  selectedIndex: number;
  threads: readonly ThreadSummary[];
}) => (
  <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
    <Text color={colors.text}>{"Resume thread"}</Text>
    <Text color={colors.dim}>{"Up/Down select, Enter resume, Esc close"}</Text>
    {threads.length === 0 ? (
      <Text color={colors.dim}>{"No saved threads yet."}</Text>
    ) : (
      threads.map((thread, index) => (
        <Text key={thread.threadId} color={index === selectedIndex ? colors.accent : colors.text}>
          {`${index === selectedIndex ? ">" : " "} ${thread.activity ?? "Untitled"}  ${formatDateTime(
            thread.updatedAt,
          )}  ${thread.resourceNames.join(", ") || "no resources"}`}
        </Text>
      ))
    )}
  </Box>
);

const Suggestions = ({
  items,
  label,
  selectedIndex,
}: {
  items: readonly string[];
  label: string;
  selectedIndex: number;
}) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text color={colors.dim}>{label}</Text>
      {items.map((item, index) => (
        <Text key={item} color={index === selectedIndex ? colors.accent : colors.text}>
          {`${index === selectedIndex ? ">" : " "} ${item}`}
        </Text>
      ))}
    </Box>
  );
};

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [provider, setProvider] = useState(tuiContext.provider);
  const [model, setModel] = useState(tuiContext.model);
  const [resources, setResources] = useState<readonly Resource[]>([]);
  const [messages, setMessages] = useState<readonly Message[]>(defaultMessages);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadResources, setThreadResources] = useState<readonly string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [threads, setThreads] = useState<readonly ThreadSummary[]>([]);
  const [selectedThreadIndex, setSelectedThreadIndex] = useState(0);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const visibleMessages = useMemo(() => {
    const width = stdout.columns || 80;
    const availableLines = Math.max(8, (stdout.rows || 24) - (resumeOpen ? 14 : 10));
    const selected: Message[] = [];
    let usedLines = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const text = message.role === "assistant" ? getAssistantText(message) : message.content;
      const lineCost =
        estimateLines(text, width - 4) +
        (message.role === "assistant" ? summarizeAssistantTools(message).length : 0) +
        2;

      if (selected.length > 0 && usedLines + lineCost > availableLines) {
        break;
      }

      selected.unshift(message);
      usedLines += lineCost;
    }

    return selected;
  }, [messages, resumeOpen, stdout.columns, stdout.rows]);

  const addSystemMessage = (content: string) =>
    setMessages((current) => [...current, { role: "system", content }]);

  const appendAssistantText = (delta: string) => {
    setMessages((current) => {
      const next = [...current];
      const last = next.at(-1);

      if (last?.role === "assistant") {
        const chunks = [...last.chunks];
        const lastChunk = chunks.at(-1);
        if (lastChunk?.type === "text") {
          chunks[chunks.length - 1] = {
            ...lastChunk,
            text: lastChunk.text + delta,
          };
        } else {
          chunks.push({ type: "text", text: delta });
        }

        next[next.length - 1] = { ...last, chunks };
        return next;
      }

      next.push({
        role: "assistant",
        chunks: [{ type: "text", text: delta }],
      });
      return next;
    });
  };

  const appendAssistantTool = (toolName: string) => {
    setMessages((current) => {
      const next = [...current];
      const last = next.at(-1);

      if (last?.role === "assistant") {
        next[next.length - 1] = {
          ...last,
          chunks: [...last.chunks, { type: "tool", toolName }],
        };
        return next;
      }

      next.push({
        role: "assistant",
        chunks: [{ type: "tool", toolName }],
      });
      return next;
    });
  };

  const markLastAssistantCanceled = () => {
    setMessages((current) => {
      const next = [...current];
      const last = next.at(-1);
      if (last?.role !== "assistant") {
        return current;
      }

      next[next.length - 1] = {
        ...last,
        canceled: true,
      };
      return next;
    });
  };

  const refreshThreads = async () => {
    const response = await fetchJson<ThreadListResponse>("/threads");
    setThreads(response.threads);
    setSelectedThreadIndex(0);
  };

  const executeCommand = async (command: CommandItem) => {
    setInput("");

    if (command.action === "clear") {
      setMessages(defaultMessages);
      setThreadId(null);
      setThreadResources([]);
      return;
    }

    if (command.action === "resume") {
      setResumeOpen(true);
      await refreshThreads();
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

    setThreadId(response.thread.threadId);
    setThreadResources(response.thread.resourceNames);
    setProvider(response.thread.provider ?? provider);
    setModel(response.thread.modelId ?? model);
    setMessages(parseThreadMessages(response.thread));
    setResumeOpen(false);
    setInput("");
  };

  const submit = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isStreaming || resumeOpen) {
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
    setMessages((current) => [...current, { role: "user", content: question }]);
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

      if (!response.ok || response.body === null) {
        throw new Error(`Server returned ${response.status} for /ask`);
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
                appendAssistantText(assistantMessageEvent.delta);
              }

              if (
                assistantMessageEvent.type === "toolcall_end" &&
                "toolCall" in assistantMessageEvent &&
                typeof assistantMessageEvent.toolCall === "object" &&
                assistantMessageEvent.toolCall !== null &&
                "name" in assistantMessageEvent.toolCall &&
                typeof assistantMessageEvent.toolCall.name === "string"
              ) {
                appendAssistantTool(assistantMessageEvent.toolCall.name);
              }
            }
          }

          if (
            outerEvent.type === "message_end" &&
            "message" in outerEvent &&
            outerEvent.message &&
            typeof outerEvent.message === "object" &&
            "role" in outerEvent.message &&
            outerEvent.message.role === "assistant" &&
            "stopReason" in outerEvent.message &&
            outerEvent.message.stopReason === "error"
          ) {
            throw new Error(
              "errorMessage" in outerEvent.message &&
                typeof outerEvent.message.errorMessage === "string"
                ? outerEvent.message.errorMessage
                : "The model request failed.",
            );
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        markLastAssistantCanceled();
        addSystemMessage("Canceled the current response.");
      } else {
        addSystemMessage(error instanceof Error ? error.message : "The agent request failed.");
      }
    } finally {
      abortControllerRef.current = null;
      setCancelPending(false);
      setIsStreaming(false);
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

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === "q") {
      abortControllerRef.current?.abort();
      exit();
      return;
    }

    if (resumeOpen) {
      if (key.escape) {
        setResumeOpen(false);
        return;
      }

      if (key.upArrow) {
        setSelectedThreadIndex((current) =>
          threads.length === 0 ? 0 : (current - 1 + threads.length) % threads.length,
        );
      }

      if (key.downArrow) {
        setSelectedThreadIndex((current) =>
          threads.length === 0 ? 0 : (current + 1) % threads.length,
        );
      }

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

    if (!isStreaming && key.escape) {
      setCancelPending(false);
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
          setInput((current) => current.replace(/(^|(?<=\s))@[^\s]*$/, `@${nextMention} `));
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Header provider={provider} model={model} />

      <Box flexDirection="column" marginTop={1}>
        {visibleMessages.map((message, index) => (
          <MessageRow key={`${index}:${message.role}`} message={message} />
        ))}
      </Box>

      {resumeOpen ? <ResumeList threads={threads} selectedIndex={selectedThreadIndex} /> : null}

      {!resumeOpen && commandMatches.length > 0 ? (
        <Suggestions
          items={commandMatches.map((command) => `${command.name}  ${command.description}`)}
          label="Commands"
          selectedIndex={selectedCommandIndex}
        />
      ) : null}

      {!resumeOpen && commandMatches.length === 0 && mentionMatches.length > 0 ? (
        <Suggestions
          items={mentionMatches.map((name) => `@${name}`)}
          label="Resources"
          selectedIndex={selectedMentionIndex}
        />
      ) : null}

      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={resumeOpen ? colors.border : colors.accent}
        paddingX={1}
      >
        <Text color={colors.accent}>{"> "}</Text>
        <TextInput
          focus={!resumeOpen}
          placeholder="@resource question... or / for commands"
          showCursor={!resumeOpen}
          value={input}
          onChange={setInput}
          onSubmit={() => {
            if (mentionMatches.length > 0) {
              const nextMention = mentionMatches[selectedMentionIndex] ?? mentionMatches[0];
              if (nextMention) {
                setInput((current) => current.replace(/(^|(?<=\s))@[^\s]*$/, `@${nextMention} `));
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

            if (resumeOpen) {
              const thread = threads[selectedThreadIndex];
              if (thread) {
                void loadThread(thread.threadId).catch((error) => {
                  addSystemMessage(
                    error instanceof Error ? error.message : "Failed to resume thread.",
                  );
                });
              }
              return;
            }

            void submit();
          }}
        />
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Text color={colors.muted}>
          {isStreaming
            ? cancelPending
              ? "Press Esc again to cancel"
              : "Streaming... Esc to cancel"
            : "Enter send  |  @resource mention  |  / commands  |  Ctrl+Q quit"}
        </Text>
        <Text color={colors.muted}>
          {`${threadResources.map((resource) => `@${resource}`).join(" ")}${
            threadResources.length > 0 ? "  " : ""
          }v${tuiContext.version}`}
        </Text>
      </Box>
    </Box>
  );
};

export const runTui = async () => {
  const instance = render(<App />);
  await instance.waitUntilExit();
};

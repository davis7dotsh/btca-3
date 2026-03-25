import { promises as Fs } from "node:fs";
import path from "node:path";

import type { Message } from "@mariozechner/pi-ai";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { Config } from "../config.ts";

type StoredThreadMessage = {
  readonly sequence: number;
  readonly role: Message["role"];
  readonly timestamp: number;
  readonly rawJson: string;
};

type StoredThread = {
  readonly threadId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: "idle" | "running" | "error";
  readonly activity: string | null;
  readonly workspaceDir: string | null;
  readonly modelId: string | null;
  readonly provider: string | null;
  readonly messages: readonly StoredThreadMessage[];
};

export class ThreadStoreError extends Data.TaggedError("ThreadStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type ThreadStoreShape = {
  readonly loadThread: (threadId: string) => Effect.Effect<StoredThread | null, ThreadStoreError>;
  readonly setThreadState: (args: {
    threadId: string;
    status: "idle" | "running" | "error";
    activity?: string | null;
    workspaceDir?: string | null;
    modelId?: string | null;
    provider?: string | null;
  }) => Effect.Effect<void, ThreadStoreError>;
  readonly appendMessages: (args: {
    threadId: string;
    messages: readonly Message[];
    workspaceDir: string;
    provider: string;
    modelId: string;
  }) => Effect.Effect<StoredThread, ThreadStoreError>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStoredMessage = (value: unknown): value is StoredThreadMessage =>
  isRecord(value) &&
  typeof value.sequence === "number" &&
  (value.role === "user" || value.role === "assistant" || value.role === "toolResult") &&
  typeof value.timestamp === "number" &&
  typeof value.rawJson === "string";

const isStoredThread = (value: unknown): value is StoredThread =>
  isRecord(value) &&
  typeof value.threadId === "string" &&
  typeof value.createdAt === "number" &&
  typeof value.updatedAt === "number" &&
  (value.status === "idle" || value.status === "running" || value.status === "error") &&
  (value.activity === null || typeof value.activity === "string") &&
  (value.workspaceDir === null || typeof value.workspaceDir === "string") &&
  (value.modelId === null || typeof value.modelId === "string") &&
  (value.provider === null || typeof value.provider === "string") &&
  Array.isArray(value.messages) &&
  value.messages.every(isStoredMessage);

const isMessage = (value: unknown): value is Message => {
  if (!isRecord(value) || typeof value.timestamp !== "number") {
    return false;
  }

  switch (value.role) {
    case "user":
      return typeof value.content === "string" || Array.isArray(value.content);
    case "assistant":
      return Array.isArray(value.content) && typeof value.model === "string";
    case "toolResult":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        Array.isArray(value.content) &&
        typeof value.isError === "boolean"
      );
    default:
      return false;
  }
};

export class AgentThreadStore extends ServiceMap.Service<AgentThreadStore, ThreadStoreShape>()(
  "btca-server/AgentThreadStore",
) {
  static readonly layer = Layer.effect(
    AgentThreadStore,
    Effect.gen(function* () {
      const config = yield* Config;

      const getThreadPath = (threadId: string) =>
        config.snapshot.pipe(
          Effect.map((snapshot) =>
            path.join(snapshot.dataDirectory, "agent-threads", `${threadId}.json`),
          ),
        );

      const writeThread = (thread: StoredThread) =>
        Effect.gen(function* () {
          const threadPath = yield* getThreadPath(thread.threadId);

          yield* Effect.tryPromise({
            try: async () => {
              await Fs.mkdir(path.dirname(threadPath), { recursive: true });
              await Fs.writeFile(threadPath, JSON.stringify(thread, null, 2), "utf8");
            },
            catch: (cause) =>
              new ThreadStoreError({
                message: `Failed to write thread "${thread.threadId}".`,
                cause,
              }),
          });
        });

      const loadThread: ThreadStoreShape["loadThread"] = (threadId) =>
        Effect.gen(function* () {
          const threadPath = yield* getThreadPath(threadId);

          const contents = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await Fs.readFile(threadPath, "utf8");
              } catch (cause) {
                if (
                  cause &&
                  typeof cause === "object" &&
                  "code" in cause &&
                  cause.code === "ENOENT"
                ) {
                  return null;
                }

                throw cause;
              }
            },
            catch: (cause) =>
              new ThreadStoreError({
                message: `Failed to read thread "${threadId}".`,
                cause,
              }),
          });

          if (contents === null) {
            return null;
          }

          const parsed = yield* Effect.try({
            try: () => JSON.parse(contents),
            catch: (cause) =>
              new ThreadStoreError({
                message: `Thread "${threadId}" is not valid JSON.`,
                cause,
              }),
          });

          if (!isStoredThread(parsed)) {
            return yield* Effect.fail(
              new ThreadStoreError({
                message: `Thread "${threadId}" does not match the expected shape.`,
              }),
            );
          }

          return parsed;
        });

      const setThreadState: ThreadStoreShape["setThreadState"] = ({
        threadId,
        status,
        activity,
        workspaceDir,
        modelId,
        provider,
      }) =>
        Effect.gen(function* () {
          const existing = yield* loadThread(threadId).pipe(Effect.orElseSucceed(() => null));
          const now = Date.now();

          const nextThread: StoredThread = {
            threadId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            status,
            activity: activity ?? existing?.activity ?? null,
            workspaceDir: workspaceDir ?? existing?.workspaceDir ?? null,
            modelId: modelId ?? existing?.modelId ?? null,
            provider: provider ?? existing?.provider ?? null,
            messages: existing?.messages ?? [],
          };

          yield* writeThread(nextThread);
        });

      const appendMessages: ThreadStoreShape["appendMessages"] = ({
        threadId,
        messages,
        workspaceDir,
        provider,
        modelId,
      }) =>
        Effect.gen(function* () {
          const existing = yield* loadThread(threadId).pipe(Effect.orElseSucceed(() => null));
          const now = Date.now();
          const baseSequence = existing?.messages.length ?? 0;

          const serialized = yield* Effect.forEach(messages, (message, index) =>
            Effect.try({
              try: () =>
                ({
                  sequence: baseSequence + index,
                  role: message.role,
                  timestamp: message.timestamp,
                  rawJson: JSON.stringify(message),
                }) satisfies StoredThreadMessage,
              catch: (cause) =>
                new ThreadStoreError({
                  message: `Failed to serialize a message for thread "${threadId}".`,
                  cause,
                }),
            }),
          );

          const nextThread: StoredThread = {
            threadId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            status: "idle",
            activity: existing?.activity ?? null,
            workspaceDir,
            provider,
            modelId,
            messages: [...(existing?.messages ?? []), ...serialized],
          };

          yield* writeThread(nextThread);
          return nextThread;
        });

      return {
        loadThread,
        setThreadState,
        appendMessages,
      } satisfies ThreadStoreShape;
    }),
  );
}

export const parsePersistedMessages = (thread: StoredThread | null) =>
  Effect.gen(function* () {
    if (thread === null) {
      return [] as Message[];
    }

    const messages = yield* Effect.forEach(thread.messages, (message) =>
      Effect.try({
        try: () => JSON.parse(message.rawJson) as unknown,
        catch: (cause) =>
          new ThreadStoreError({
            message: `Failed to parse stored message ${message.sequence} for thread "${thread.threadId}".`,
            cause,
          }),
      }).pipe(
        Effect.flatMap((parsed) =>
          isMessage(parsed)
            ? Effect.succeed(parsed)
            : Effect.fail(
                new ThreadStoreError({
                  message: `Stored message ${message.sequence} for thread "${thread.threadId}" has an invalid shape.`,
                }),
              ),
        ),
      ),
    );

    return messages;
  });

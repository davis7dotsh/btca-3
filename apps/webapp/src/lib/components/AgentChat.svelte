<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Usage } from '@mariozechner/pi-ai';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { api } from '@btca/convex/api';
	import {
		addUsd,
		calculateExaContentCostUsd,
		calculateExaSearchCostUsd
	} from '$lib/billing/usage';
	import { getHumanErrorMessage } from '$lib/errors';
	import MarkdownMessage from '$lib/components/MarkdownMessage.svelte';
	import {
		agentModelOptions,
		defaultAgentModelId,
		findAgentModelOptionForProviderModel,
		getAgentModelOption
	} from '$lib/models';
	import { normalizeResourceSlug } from '$lib/resources';
	import type { AgentModelId, AgentModelOption } from '$lib/models';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import type {
		AgentPromptStreamEvent,
		AgentToolCallEndEvent,
		ExecCommandToolArgs,
		ReadFileToolArgs,
		SandboxExecuteCommandResult,
		SandboxReadFileResult,
		StoredAgentThreadMessage
	} from '$lib/types/agent';
	import {
		isAssistantMessage as isPersistedAssistantMessage,
		isExecCommandToolArgs,
		isReadFileToolArgs,
		isToolResultMessage,
		isUserMessage as isPersistedUserMessage
	} from '$lib/types/agent';
	import type { ExaGetWebContentInput, ExaSearchWebInput } from '$lib/services/exa';

	const { routeBase = '/app/chat', agentApiPath = '/api/agent' } = $props<{
		routeBase?: string;
		agentApiPath?: string;
	}>();

	type ToolStatus = 'running' | 'done' | 'error';

	interface TextPart {
		id: string;
		type: 'text';
		content: string;
	}

	interface ReadFileToolState {
		id: string;
		toolType: 'read_file';
		status: ToolStatus;
		args: ReadFileToolArgs | null;
		details: SandboxReadFileResult | null;
		content: string;
	}

	interface ExecCommandToolState {
		id: string;
		toolType: 'exec_command';
		status: ToolStatus;
		args: ExecCommandToolArgs | null;
		details: SandboxExecuteCommandResult | null;
		content: string;
	}

	interface UnknownToolState {
		id: string;
		toolType: 'unknown';
		toolName: string;
		status: ToolStatus;
		args: unknown;
		details: unknown;
		content: string;
	}

	type ToolCallState = ReadFileToolState | ExecCommandToolState | UnknownToolState;

	interface ToolPart {
		type: 'tool';
		tool: ToolCallState;
	}

	type ContentPart = TextPart | ToolPart;

	interface TextSegment {
		type: 'text';
		part: TextPart;
	}

	interface ToolGroupSegment {
		type: 'tool_group';
		tools: ToolCallState[];
	}

	type MessageSegment = TextSegment | ToolGroupSegment;

	interface UserMessage {
		id: string;
		role: 'user';
		content: string;
		createdAt: number;
		persistedSequence: number | null;
	}

	interface AssistantMessage {
		id: string;
		role: 'assistant';
		parts: ContentPart[];
		pending: boolean;
		createdAt: number;
		stats: AssistantStats;
	}

	interface SystemMessage {
		id: string;
		role: 'system';
		content: string;
		createdAt: number;
	}

	type ChatMessage = UserMessage | AssistantMessage | SystemMessage;
	type CopyStatus = 'idle' | 'copied' | 'error';

	interface AssistantStats {
		model: AgentModelOption | null;
		providerModelId: string | null;
		api: string | null;
		provider: string | null;
		completedUsage: Usage | null;
		liveUsage: Usage | null;
		billedCostUsd: number;
		completedAt: number | null;
		toolCallDurationMs: number;
		activeToolCallCount: number;
		activeToolCallStartedAt: number | null;
	}

	interface ResourceMentionState {
		query: string;
		start: number;
		end: number;
	}

	const authContext = getAuthContext();
	const convex = useConvexClient();
	const createId = () => crypto.randomUUID();
	const createThreadId = () => `chat-${crypto.randomUUID()}`;

	const getAssistantText = (message: AssistantMessage) =>
		message.parts.flatMap((part) => (part.type === 'text' ? [part.content] : [])).join('');

	const formatToolForCopy = (tool: ToolCallState) => {
		const header = `[Tool: ${getToolLabel(tool)} | ${tool.status}]`;

		switch (tool.toolType) {
			case 'read_file': {
				const path = tool.details?.path ?? tool.args?.path ?? 'Unknown file';
				const range = getReadFileMeta(tool.details);
				const content =
					tool.details?.content ||
					tool.content ||
					(tool.args ? prettyJson(tool.args) : 'No file content returned.');

				return `${header}\nPath: ${path}\nRange: ${range}\n${content}`;
			}
			case 'exec_command': {
				const command = tool.details?.command ?? tool.args?.command ?? 'Unknown command';
				const cwd = tool.details?.cwd ?? tool.args?.cwd ?? '/workspace';
				const exitCode = tool.details?.exitCode ?? 'unknown';
				const output =
					[tool.details?.stdout, tool.details?.stderr, tool.content]
						.filter((value): value is string => Boolean(value && value.trim()))
						.join('\n\n') || 'No command output returned.';

				return `${header}\nCommand: ${command}\nWorking directory: ${cwd}\nExit code: ${exitCode}\n${output}`;
			}
			case 'unknown':
				return `${header}\nArguments:\n${prettyJson(tool.args)}\n\nDetails:\n${prettyJson(tool.details)}${tool.content ? `\n\nContent:\n${tool.content}` : ''}`;
		}
	};

	const formatAssistantMessageForCopy = (message: AssistantMessage) =>
		message.parts
			.flatMap((part) => (part.type === 'text' ? [part.content.trim()] : []))
			.filter((part) => part.length > 0)
			.join('\n\n')
			.trim();

	const formatChatMessageForCopy = (message: ChatMessage) => {
		switch (message.role) {
			case 'user':
				return `User:\n${message.content.trim()}`;
			case 'assistant':
				return `Assistant:\n${formatAssistantMessageForCopy(message)}`;
			case 'system':
				return `System:\n${message.content.trim()}`;
		}
	};

	const formatThreadMessageForCopy = (message: ChatMessage) => {
		switch (message.role) {
			case 'user':
				return `User:\n${message.content.trim()}`;
			case 'assistant': {
				const content = formatAssistantMessageForCopy(message);
				return content ? `Assistant:\n${content}` : '';
			}
			case 'system':
				return '';
		}
	};

	const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === 'object' && value !== null;
	const cloneUsage = (usage: Usage | null) =>
		usage
			? {
					...usage,
					cost: { ...usage.cost }
				}
			: null;
	const createEmptyUsage = (): Usage => ({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	});
	const addUsage = (left: Usage | null, right: Usage | null) => {
		if (!left && !right) {
			return null;
		}

		const base = left ? (cloneUsage(left) ?? createEmptyUsage()) : createEmptyUsage();

		if (!right) {
			return base;
		}

		return {
			input: base.input + right.input,
			output: base.output + right.output,
			cacheRead: base.cacheRead + right.cacheRead,
			cacheWrite: base.cacheWrite + right.cacheWrite,
			totalTokens: base.totalTokens + right.totalTokens,
			cost: {
				input: base.cost.input + right.cost.input,
				output: base.cost.output + right.cost.output,
				cacheRead: base.cost.cacheRead + right.cost.cacheRead,
				cacheWrite: base.cost.cacheWrite + right.cost.cacheWrite,
				total: base.cost.total + right.cost.total
			}
		};
	};
	const createAssistantStats = (model: AgentModelOption | null = null): AssistantStats => ({
		model,
		providerModelId: model?.modelId ?? null,
		api: model?.api ?? null,
		provider: model?.provider ?? null,
		completedUsage: null,
		liveUsage: null,
		billedCostUsd: 0,
		completedAt: null,
		toolCallDurationMs: 0,
		activeToolCallCount: 0,
		activeToolCallStartedAt: null
	});
	const cloneAssistantStats = (stats: AssistantStats): AssistantStats => ({
		...stats,
		model: stats.model ? { ...stats.model } : null,
		completedUsage: cloneUsage(stats.completedUsage),
		liveUsage: cloneUsage(stats.liveUsage)
	});
	const getAssistantUsage = (message: AssistantMessage) =>
		addUsage(message.stats.completedUsage, message.stats.liveUsage);
	const getAssistantBilledCostUsd = (message: AssistantMessage) => message.stats.billedCostUsd;
	const numberFormatter = new Intl.NumberFormat();
	const tokenRateFormatter = new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1
	});
	const currencyFormatter = new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 4,
		maximumFractionDigits: 4
	});
	const formatTokenCount = (value: number) => numberFormatter.format(value);
	const formatCost = (value: number) => currencyFormatter.format(value);
	const getAssistantToolDurationMs = (message: AssistantMessage) => {
		const liveToolDurationMs =
			message.pending &&
			message.stats.activeToolCallCount > 0 &&
			message.stats.activeToolCallStartedAt !== null
				? Math.max(0, Date.now() - message.stats.activeToolCallStartedAt)
				: 0;

		return message.stats.toolCallDurationMs + liveToolDurationMs;
	};
	const getAssistantDurationMs = (message: AssistantMessage) => {
		const completedAt = message.pending ? Date.now() : message.stats.completedAt;

		if (!completedAt || completedAt <= message.createdAt) {
			return null;
		}

		const activeGenerationDurationMs =
			completedAt - message.createdAt - getAssistantToolDurationMs(message);

		if (activeGenerationDurationMs <= 0) {
			return null;
		}

		return activeGenerationDurationMs;
	};
	const getAssistantOutputTokensPerSecond = (message: AssistantMessage) => {
		const usage = getAssistantUsage(message);
		const durationMs = getAssistantDurationMs(message);

		if (!usage || !durationMs || usage.output <= 0) {
			return null;
		}

		return usage.output / (durationMs / 1000);
	};
	const getAssistantModelLabel = (message: AssistantMessage) =>
		message.stats.model?.label ??
		(message.stats.providerModelId ? `${message.stats.providerModelId}` : 'Unknown model');
	const isPricingVisible = (message: AssistantMessage) => {
		const usage = getAssistantUsage(message);

		if (message.stats.billedCostUsd > 0) {
			return true;
		}

		if (!usage) {
			return false;
		}

		return message.stats.model?.pricingConfigured ?? usage.cost.total > 0;
	};

	const parseExaSearchArgs = (value: unknown): ExaSearchWebInput | null => {
		if (!isRecord(value) || typeof value.query !== 'string' || value.query.length === 0) {
			return null;
		}

		return {
			query: value.query,
			...(typeof value.numResults === 'number' ? { numResults: value.numResults } : {}),
			...(Array.isArray(value.includeDomains)
				? {
						includeDomains: value.includeDomains.filter(
							(domain): domain is string => typeof domain === 'string'
						)
					}
				: {}),
			...(Array.isArray(value.excludeDomains)
				? {
						excludeDomains: value.excludeDomains.filter(
							(domain): domain is string => typeof domain === 'string'
						)
					}
				: {}),
			...(typeof value.startPublishedDate === 'string'
				? { startPublishedDate: value.startPublishedDate }
				: {}),
			...(typeof value.endPublishedDate === 'string'
				? { endPublishedDate: value.endPublishedDate }
				: {})
		};
	};

	const parseExaGetWebContentArgs = (value: unknown): ExaGetWebContentInput | null => {
		if (!isRecord(value) || !Array.isArray(value.urls)) {
			return null;
		}

		const urls = value.urls.filter((url): url is string => typeof url === 'string' && url.length > 0);

		if (urls.length === 0) {
			return null;
		}

		return {
			urls,
			...(typeof value.maxCharacters === 'number' ? { maxCharacters: value.maxCharacters } : {}),
			...(typeof value.summary === 'boolean' ? { summary: value.summary } : {}),
			...(typeof value.highlightsQuery === 'string'
				? { highlightsQuery: value.highlightsQuery }
				: {}),
			...(typeof value.maxAgeHours === 'number' ? { maxAgeHours: value.maxAgeHours } : {})
		};
	};

	const getToolBilledCostUsd = ({
		streamEvent,
		tool
	}: {
		streamEvent: AgentToolCallEndEvent;
		tool: ToolCallState | null;
	}) => {
		if (streamEvent.isError) {
			return 0;
		}

		if (streamEvent.toolType === 'exec_command') {
			return streamEvent.details?.costUsd ?? 0;
		}

		if (streamEvent.toolType !== 'unknown') {
			return 0;
		}

		if (streamEvent.toolName === 'searchWeb') {
			return calculateExaSearchCostUsd(
				parseExaSearchArgs(tool?.toolType === 'unknown' ? tool.args : null)
			);
		}

		if (streamEvent.toolName === 'getWebContent') {
			const input = parseExaGetWebContentArgs(tool?.toolType === 'unknown' ? tool.args : null);
			const pageCount =
				isRecord(streamEvent.details) && typeof streamEvent.details.count === 'number'
					? streamEvent.details.count
					: 0;

			return calculateExaContentCostUsd({
				input,
				pageCount
			});
		}

		return 0;
	};

	const getToolTypeClass = (tool: ToolCallState) => {
		if (tool.toolType === 'exec_command') return 'tool-type-exec';
		if (tool.toolType === 'read_file') return 'tool-type-read';
		if (
			tool.toolType === 'unknown' &&
			(tool.toolName === 'searchWeb' || tool.toolName === 'getWebContent')
		) {
			return 'tool-type-search';
		}
		return '';
	};

	const getToolGroupTypeClass = (tools: ToolCallState[]) => {
		const first = tools[0];
		if (!first) return '';
		return getToolTypeClass(first);
	};

	const getToolLabel = (tool: ToolCallState) => {
		switch (tool.toolType) {
			case 'read_file':
				return 'Read file';
			case 'exec_command':
				return 'Run command';
			case 'unknown':
				return tool.toolName;
		}
	};

	const getToolSummary = (tool: ToolCallState) => {
		switch (tool.toolType) {
			case 'read_file': {
				const path = tool.details?.path ?? tool.args?.path ?? 'Unknown file';

				if (!tool.details) {
					return path;
				}

				if (tool.details.lineEnd < tool.details.lineStart) {
					return `${path} · no lines returned`;
				}

				return `${path} · lines ${tool.details.lineStart}-${tool.details.lineEnd}`;
			}
			case 'exec_command':
				return tool.details?.command ?? tool.args?.command ?? 'Unknown command';
			case 'unknown':
				return tool.toolName;
		}
	};

	const groupMessageParts = (parts: ContentPart[]): MessageSegment[] => {
		const segments: MessageSegment[] = [];

		for (const part of parts) {
			if (part.type === 'text') {
				if (part.content.trim()) {
					segments.push({ type: 'text', part });
				}
			} else {
				const lastSegment = segments[segments.length - 1];

				if (lastSegment?.type === 'tool_group') {
					lastSegment.tools.push(part.tool);
				} else {
					segments.push({ type: 'tool_group', tools: [part.tool] });
				}
			}
		}

		return segments;
	};

	const getToolGroupStatus = (tools: ToolCallState[]): ToolStatus => {
		if (tools.some((t) => t.status === 'running')) return 'running';
		if (tools.some((t) => t.status === 'error')) return 'error';
		return 'done';
	};

	const getToolGroupSummary = (tools: ToolCallState[]) => {
		const readCount = tools.filter((t) => t.toolType === 'read_file').length;
		const execCount = tools.filter((t) => t.toolType === 'exec_command').length;
		const otherCount = tools.filter((t) => t.toolType === 'unknown').length;
		const parts: string[] = [];

		if (readCount > 0) parts.push(readCount === 1 ? 'Read a file' : `Read ${readCount} files`);
		if (execCount > 0) parts.push(execCount === 1 ? 'Ran a command' : `Ran ${execCount} commands`);
		if (otherCount > 0) parts.push(otherCount === 1 ? '1 other tool' : `${otherCount} other tools`);

		return parts.join(', ');
	};

	const getToolGroupLabel = (tools: ToolCallState[]) => {
		const running = tools.filter((t) => t.status === 'running');

		if (running.length > 0) {
			const last = running[running.length - 1];

			if (last.toolType === 'read_file') return 'Reading a file...';
			if (last.toolType === 'exec_command') return 'Running a command...';
			return `Running ${last.toolType === 'unknown' ? last.toolName : 'tool'}...`;
		}

		return getToolGroupSummary(tools);
	};

	const getToolGroupKey = (tools: ToolCallState[]) => tools[0]?.id ?? 'empty';

	const getReadFileLines = (details: SandboxReadFileResult | null) => {
		if (!details || details.content.length === 0 || details.lineEnd < details.lineStart) {
			return [];
		}

		return details.content.split('\n').map((content, index) => ({
			number: details.lineStart + index,
			content
		}));
	};

	const getReadFileMeta = (details: SandboxReadFileResult | null) => {
		if (!details) {
			return 'Awaiting file details';
		}

		if (details.lineEnd < details.lineStart) {
			return `No lines returned from ${details.path}`;
		}

		const range =
			details.lineStart === details.lineEnd
				? `Line ${details.lineStart}`
				: `Lines ${details.lineStart}-${details.lineEnd}`;

		return `${range} of ${details.totalLines}`;
	};

	const extractPersistedText = (value: unknown) => {
		if (typeof value === 'string') {
			return value;
		}

		if (!Array.isArray(value)) {
			return '';
		}

		return value
			.flatMap((part) => {
				if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
					return [part.text];
				}

				return [];
			})
			.join('\n\n');
	};

	const cloneToolState = (tool: ToolCallState): ToolCallState => {
		switch (tool.toolType) {
			case 'read_file':
				return {
					...tool,
					args: tool.args ? { ...tool.args } : null,
					details: tool.details ? { ...tool.details } : null
				};
			case 'exec_command':
				return {
					...tool,
					args: tool.args ? { ...tool.args } : null,
					details: tool.details ? { ...tool.details } : null
				};
			case 'unknown':
				return {
					...tool,
					args: tool.args,
					details: tool.details
				};
		}
	};

	const cloneContentPart = (part: ContentPart): ContentPart =>
		part.type === 'text' ? { ...part } : { type: 'tool', tool: cloneToolState(part.tool) };

	const cloneChatMessage = (message: ChatMessage): ChatMessage => {
		switch (message.role) {
			case 'user':
			case 'system':
				return { ...message };
			case 'assistant':
				return {
					...message,
					stats: cloneAssistantStats(message.stats),
					parts: message.parts.map(cloneContentPart)
				};
		}
	};

	const cloneChatMessages = (value: ChatMessage[]) => value.map(cloneChatMessage);

	const createHydratedToolState = (toolCallId: string, toolName: string, args: unknown) => {
		if (toolName === 'read_file' && isReadFileToolArgs(args)) {
			return {
				id: toolCallId,
				toolType: 'read_file' as const,
				status: 'running' as const,
				args,
				details: null,
				content: ''
			};
		}

		if (toolName === 'exec_command' && isExecCommandToolArgs(args)) {
			return {
				id: toolCallId,
				toolType: 'exec_command' as const,
				status: 'running' as const,
				args,
				details: null,
				content: ''
			};
		}

		return {
			id: toolCallId,
			toolType: 'unknown' as const,
			toolName,
			status: 'running' as const,
			args,
			details: null,
			content: ''
		};
	};

	const getOrCreateHydratedAssistant = (value: ChatMessage[], createdAt: number) => {
		const lastMessage = value[value.length - 1];

		if (lastMessage?.role === 'assistant') {
			return lastMessage;
		}

		const nextAssistant: AssistantMessage = {
			id: createId(),
			role: 'assistant',
			parts: [],
			pending: false,
			createdAt,
			stats: createAssistantStats()
		};

		value.push(nextAssistant);
		return nextAssistant;
	};

	const hydrateStoredThreadMessages = (storedMessages: readonly StoredAgentThreadMessage[]) => {
		const hydratedMessages: ChatMessage[] = [];
		const toolStates: Record<string, ToolCallState> = {};

		for (const storedMessage of storedMessages) {
			let parsedMessage: unknown;

			try {
				parsedMessage = JSON.parse(storedMessage.rawJson);
			} catch (error) {
				console.warn('Failed to parse persisted thread message', {
					sequence: storedMessage.sequence,
					error
				});
				continue;
			}

			if (isPersistedUserMessage(parsedMessage)) {
				hydratedMessages.push({
					id: createId(),
					role: 'user',
					content: extractPersistedText(parsedMessage.content),
					createdAt: parsedMessage.timestamp,
					persistedSequence: storedMessage.sequence
				});
				continue;
			}

			if (isPersistedAssistantMessage(parsedMessage)) {
				const assistantMessage = getOrCreateHydratedAssistant(
					hydratedMessages,
					parsedMessage.timestamp
				);
				const mappedModel = findAgentModelOptionForProviderModel({
					api: parsedMessage.api,
					provider: parsedMessage.provider,
					modelId: parsedMessage.model
				});

				assistantMessage.stats = {
					model: mappedModel ?? assistantMessage.stats.model,
					providerModelId: parsedMessage.model,
					api: parsedMessage.api,
					provider: parsedMessage.provider,
					completedUsage: addUsage(assistantMessage.stats.completedUsage, parsedMessage.usage),
					liveUsage: null,
					billedCostUsd: addUsd(assistantMessage.stats.billedCostUsd, parsedMessage.usage.cost.total),
					completedAt: parsedMessage.timestamp,
					toolCallDurationMs: assistantMessage.stats.toolCallDurationMs,
					activeToolCallCount: 0,
					activeToolCallStartedAt: null
				};

				if (parsedMessage.errorMessage?.trim()) {
					assistantMessage.parts.push({
						id: createId(),
						type: 'text',
						content: parsedMessage.errorMessage
					});
				}

				for (const part of parsedMessage.content) {
					if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
						assistantMessage.parts.push({
							id: createId(),
							type: 'text',
							content: part.text
						});
						continue;
					}

					if (
						isRecord(part) &&
						part.type === 'toolCall' &&
						typeof part.id === 'string' &&
						typeof part.name === 'string'
					) {
						const toolState = createHydratedToolState(part.id, part.name, part.arguments);
						assistantMessage.parts.push({
							type: 'tool',
							tool: toolState
						});
						toolStates[part.id] = toolState;
					}
				}

				continue;
			}

			if (isToolResultMessage(parsedMessage)) {
				const assistantMessage = getOrCreateHydratedAssistant(
					hydratedMessages,
					parsedMessage.timestamp
				);
				const toolState =
					toolStates[parsedMessage.toolCallId] ??
					createHydratedToolState(parsedMessage.toolCallId, parsedMessage.toolName, null);

				toolState.status = parsedMessage.isError ? 'error' : 'done';
				toolState.content = extractPersistedText(parsedMessage.content);

				if (!toolStates[parsedMessage.toolCallId]) {
					assistantMessage.parts.push({
						type: 'tool',
						tool: toolState
					});
					toolStates[parsedMessage.toolCallId] = toolState;
				}
			}
		}

		return hydratedMessages;
	};

	let messages = $state<ChatMessage[]>([]);
	let draft = $state('');
	let selectedModelId = $state<AgentModelId>(defaultAgentModelId);
	let threadId = $state<string | null>(page.params.id ?? null);
	let errorMessage = $state<string | null>(null);
	let isStreaming = $state(false);
	let toolExpanded = $state<Record<string, boolean>>({});
	let toolGroupExpanded = $state<Record<string, boolean>>({});
	let composer = $state<HTMLTextAreaElement | null>(null);
	let scrollContainer = $state<HTMLDivElement | null>(null);
	let messageCopyState = $state<Record<string, CopyStatus>>({});
	let fullThreadCopyState = $state<CopyStatus>('idle');
	let modelPickerOpen = $state(false);
	let mentionMenuIndex = $state(0);
	let retryingMessageId = $state<string | null>(null);
	let mentionState = $state<ResourceMentionState | null>(null);
	let threadMessageCache: Record<string, ChatMessage[]> = {};
	let threadPersistedMessageCountCache: Record<string, number> = {};
	let currentRequest: AbortController | null = null;

	const threadQuery = useQuery(
		api.authed.agentThreads.get,
		() => (authContext.currentUser && threadId ? { threadId } : 'skip'),
		() => ({ keepPreviousData: true })
	);
	const resourcesQuery = useQuery(
		api.authed.resources.list,
		() => (authContext.currentUser ? {} : 'skip'),
		() => ({ keepPreviousData: true })
	);
	const resourceItems = $derived(resourcesQuery.data ?? []);
	const routeThreadId = $derived(page.params.id ?? null);
	const selectedModel = $derived(getAgentModelOption(selectedModelId));
	const chatRouteBase = $derived(resolve(routeBase));
	const resolvedAgentApiPath = $derived(resolve(agentApiPath));
	const assistantMessages = $derived(
		messages.filter((message): message is AssistantMessage => message.role === 'assistant')
	);
	const lastAssistantMessage = $derived(
		assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null
	);
	const lastAssistantText = $derived(
		lastAssistantMessage ? getAssistantText(lastAssistantMessage) : ''
	);
	const hydratedThreadMessages = $derived.by(() => {
		if (!threadId || threadQuery.data === undefined || threadQuery.data === null) {
			return null;
		}

		if (threadQuery.data.thread.threadId !== threadId) {
			return null;
		}

		return hydrateStoredThreadMessages(threadQuery.data.messages);
	});
	const fullThreadCopyText = $derived(
		messages
			.map((message) => formatThreadMessageForCopy(message))
			.filter((message) => message.trim().length > 0)
			.join('\n\n---\n\n')
	);
	const resourceMentionSuggestions = $derived.by(() => {
		if (mentionState === null) {
			return [];
		}

		const rawQuery = mentionState.query.trim();
		const query = rawQuery.length === 0 ? '' : normalizeResourceSlug(rawQuery);
		const rankedMatches = resourceItems
			.map((resource) => {
				const slug = resource.slug.toLowerCase();
				const name = resource.name.toLowerCase();
				let score = 0;

				if (query.length === 0) {
					score = 1;
				} else if (slug === query) {
					score = 6;
				} else if (name === query) {
					score = 5;
				} else if (slug.startsWith(query)) {
					score = 4;
				} else if (name.startsWith(query)) {
					score = 3;
				} else if (slug.includes(query)) {
					score = 2;
				} else if (name.includes(query)) {
					score = 1;
				}

				return { resource, score };
			})
			.filter((candidate) => candidate.score > 0)
			.sort(
				(left, right) =>
					right.score - left.score || left.resource.name.localeCompare(right.resource.name)
			)
			.slice(0, 8)
			.map((candidate) => candidate.resource);

		return rankedMatches;
	});
	$effect(() => {
		if (routeThreadId === threadId) {
			return;
		}

		resetTransientConversationState({ clearDraft: false });
		threadId = routeThreadId;
		restoreThreadMessages(routeThreadId);
	});

	$effect(() => {
		if (!threadId || messages.length === 0) {
			return;
		}

		threadMessageCache[threadId] = cloneChatMessages(messages);
	});

	$effect(() => {
		if (!threadId || isStreaming || threadQuery.isLoading || hydratedThreadMessages === null) {
			return;
		}

		threadPersistedMessageCountCache[threadId] = threadQuery.data?.thread.messageCount ?? 0;

		if (threadMessageCache[threadId] !== undefined) {
			return;
		}

		messages = hydratedThreadMessages;
		threadMessageCache[threadId] = cloneChatMessages(hydratedThreadMessages);
	});

	let upScrollCursor = $state<number | null>(null);

	function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
		if (!scrollContainer) {
			return;
		}

		upScrollCursor = null;
		scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
	}

	function scrollToPreviousExchange() {
		if (!scrollContainer) {
			return;
		}

		const userMessages = messages.filter((m) => m.role === 'user');

		if (userMessages.length === 0) {
			scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
			return;
		}

		const nextCursor =
			upScrollCursor === null ? userMessages.length - 1 : Math.max(0, upScrollCursor - 1);

		upScrollCursor = nextCursor;
		const target = userMessages[nextCursor];

		if (!target) {
			return;
		}

		if (nextCursor === 0) {
			const el = scrollContainer.querySelector(`[data-message-id="${target.id}"]`);
			if (el) {
				const containerRect = scrollContainer.getBoundingClientRect();
				const elRect = el.getBoundingClientRect();
				const isAtTop = Math.abs(elRect.top - containerRect.top) < 8;

				if (isAtTop) {
					scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
					return;
				}
			}
		}

		const el = scrollContainer.querySelector(`[data-message-id="${target.id}"]`);

		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	function updateAssistantMessage(
		messageId: string,
		updater: (message: AssistantMessage) => AssistantMessage
	) {
		messages = messages.map((message) => {
			if (message.id !== messageId || message.role !== 'assistant') {
				return message;
			}

			return updater(message);
		});
	}

	function updateAssistantStats(
		messageId: string,
		updater: (stats: AssistantStats) => AssistantStats
	) {
		updateAssistantMessage(messageId, (message) => ({
			...message,
			stats: updater(message.stats)
		}));
	}

	function appendSystemMessage(content: string) {
		messages = [...messages, { id: createId(), role: 'system', content, createdAt: Date.now() }];
	}

	function resetTransientConversationState({ clearDraft }: { clearDraft: boolean }) {
		currentRequest?.abort();
		currentRequest = null;
		errorMessage = null;
		isStreaming = false;
		retryingMessageId = null;
		upScrollCursor = null;
		toolExpanded = {};
		toolGroupExpanded = {};
		messageCopyState = {};
		fullThreadCopyState = 'idle';

		if (clearDraft) {
			draft = '';
			mentionState = null;
			mentionMenuIndex = 0;
		}
	}

	function restoreThreadMessages(nextThreadId: string | null) {
		if (!nextThreadId) {
			messages = [];
			return;
		}

		const cachedMessages = threadMessageCache[nextThreadId];
		messages = cachedMessages ? cloneChatMessages(cachedMessages) : [];
	}

	function getThreadPath(targetThreadId: string) {
		return resolve(`/app/chat/${encodeURIComponent(targetThreadId)}`);
	}

	async function syncThreadUrl(nextThreadId: string | null, replaceState: boolean) {
		if (nextThreadId) {
			await goto(getThreadPath(nextThreadId), {
				replaceState,
				noScroll: true,
				keepFocus: true
			});
			return;
		}

		await goto(chatRouteBase, {
			replaceState,
			noScroll: true,
			keepFocus: true
		});
	}

	async function ensureThreadId() {
		if (threadId) {
			return threadId;
		}

		const nextThreadId = createThreadId();
		const createdThread = await convex.mutation(api.authed.agentThreads.create, {
			threadId: nextThreadId
		});

		threadId = createdThread.threadId;
		threadPersistedMessageCountCache[createdThread.threadId] = 0;
		await syncThreadUrl(createdThread.threadId, true);
		return createdThread.threadId;
	}

	function getThreadPersistedMessageCount(targetThreadId: string) {
		const cachedCount = threadPersistedMessageCountCache[targetThreadId];

		if (cachedCount !== undefined) {
			return cachedCount;
		}

		if (threadQuery.data?.thread.threadId === targetThreadId) {
			return threadQuery.data.thread.messageCount;
		}

		return 0;
	}

	function setThreadPersistedMessageCount(targetThreadId: string, count: number) {
		threadPersistedMessageCountCache[targetThreadId] = count;
	}

	function parseAgentStreamEvent(block: string) {
		const data = block
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n');

		if (!data) {
			return null;
		}

		return JSON.parse(data) as AgentPromptStreamEvent;
	}

	function appendAssistantText(messageId: string, delta: string) {
		updateAssistantMessage(messageId, (message) => {
			const lastPart = message.parts[message.parts.length - 1];

			if (lastPart?.type === 'text') {
				return {
					...message,
					parts: [...message.parts.slice(0, -1), { ...lastPart, content: lastPart.content + delta }]
				};
			}

			return {
				...message,
				parts: [...message.parts, { id: createId(), type: 'text', content: delta }]
			};
		});
	}

	function upsertToolPart(
		messageId: string,
		toolId: string,
		updater: (tool: ToolCallState | null) => ToolCallState
	) {
		updateAssistantMessage(messageId, (message) => {
			const index = message.parts.findIndex(
				(part) => part.type === 'tool' && part.tool.id === toolId
			);

			if (index === -1) {
				return {
					...message,
					parts: [...message.parts, { type: 'tool', tool: updater(null) }]
				};
			}

			const nextParts = [...message.parts];
			const currentPart = nextParts[index];

			if (currentPart?.type !== 'tool') {
				return message;
			}

			nextParts[index] = { type: 'tool', tool: updater(currentPart.tool) };

			return {
				...message,
				parts: nextParts
			};
		});
	}

	function getAssistantTool(messageId: string, toolId: string) {
		const assistantMessage = messages.find(
			(message): message is AssistantMessage => message.id === messageId && message.role === 'assistant'
		);

		if (!assistantMessage) {
			return null;
		}

		const toolPart = assistantMessage.parts.find(
			(part) => part.type === 'tool' && part.tool.id === toolId
		);

		return toolPart?.type === 'tool' ? toolPart.tool : null;
	}

	function toggleTool(toolId: string) {
		toolExpanded = {
			...toolExpanded,
			[toolId]: !toolExpanded[toolId]
		};
	}

	function toggleToolGroup(groupKey: string) {
		toolGroupExpanded = {
			...toolGroupExpanded,
			[groupKey]: !toolGroupExpanded[groupKey]
		};
	}

	function setMessageCopyStatus(messageId: string, status: CopyStatus) {
		messageCopyState = {
			...messageCopyState,
			[messageId]: status
		};

		if (status === 'idle') {
			return;
		}

		window.setTimeout(() => {
			if (messageCopyState[messageId] !== status) {
				return;
			}

			messageCopyState = {
				...messageCopyState,
				[messageId]: 'idle'
			};
		}, 2000);
	}

	function setFullThreadCopyStatus(status: CopyStatus) {
		fullThreadCopyState = status;

		if (status === 'idle') {
			return;
		}

		window.setTimeout(() => {
			if (fullThreadCopyState !== status) {
				return;
			}

			fullThreadCopyState = 'idle';
		}, 2000);
	}

	function getPromptForAssistantMessage(messageId: string) {
		const messageIndex = messages.findIndex((message) => message.id === messageId);

		if (messageIndex === -1) {
			return null;
		}

		for (let index = messageIndex - 1; index >= 0; index -= 1) {
			const candidate = messages[index];

			if (candidate?.role === 'user') {
				return candidate;
			}
		}

		return null;
	}

	async function copyAttachedMessage(message: AssistantMessage) {
		const prompt = getPromptForAssistantMessage(message.id);
		const assistantText = formatAssistantMessageForCopy(message);
		const sections = [prompt?.content.trim(), assistantText].filter(
			(value): value is string => Boolean(value && value.trim())
		);

		if (sections.length === 0) {
			setMessageCopyStatus(message.id, 'error');
			return;
		}

		try {
			await navigator.clipboard.writeText(sections.join('\n\n'));
			setMessageCopyStatus(message.id, 'copied');
		} catch {
			setMessageCopyStatus(message.id, 'error');
		}
	}

	async function copyFullThread() {
		if (!fullThreadCopyText.trim()) {
			setFullThreadCopyStatus('error');
			return;
		}

		try {
			await navigator.clipboard.writeText(fullThreadCopyText);
			setFullThreadCopyStatus('copied');
		} catch {
			setFullThreadCopyStatus('error');
		}
	}

	function handleStreamEvent(assistantId: string, streamEvent: AgentPromptStreamEvent) {
		switch (streamEvent.type) {
			case 'ready':
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					model: streamEvent.model,
					providerModelId: streamEvent.model.modelId,
					api: streamEvent.model.api,
					provider: streamEvent.model.provider
				}));
				return;
			case 'assistant_text_delta':
				if (streamEvent.usage) {
					updateAssistantStats(assistantId, (stats) => ({
						...stats,
						liveUsage: cloneUsage(streamEvent.usage)
					}));
				}

				appendAssistantText(assistantId, streamEvent.delta);
				return;
			case 'assistant_message':
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					providerModelId: streamEvent.model,
					api: streamEvent.api,
					provider: streamEvent.provider,
					model:
						findAgentModelOptionForProviderModel({
							api: streamEvent.api,
							provider: streamEvent.provider,
							modelId: streamEvent.model
						}) ?? stats.model,
					completedUsage: addUsage(stats.completedUsage, streamEvent.usage),
					billedCostUsd: addUsd(stats.billedCostUsd, streamEvent.usage.cost.total),
					liveUsage: null,
					completedAt: streamEvent.timestamp
				}));

				updateAssistantMessage(assistantId, (message) => {
					const resolvedContent =
						streamEvent.content.trim() || streamEvent.errorMessage?.trim() || '';
					const hasText = message.parts.some(
						(part) => part.type === 'text' && part.content.trim().length > 0
					);

					if (hasText || !resolvedContent) {
						return message;
					}

					return {
						...message,
						parts: [...message.parts, { id: createId(), type: 'text', content: resolvedContent }]
					};
				});
				return;
			case 'tool_call_start': {
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					activeToolCallCount: stats.activeToolCallCount + 1,
					activeToolCallStartedAt:
						stats.activeToolCallCount === 0 ? streamEvent.timestamp : stats.activeToolCallStartedAt
				}));

				if (streamEvent.toolType === 'read_file') {
					upsertToolPart(assistantId, streamEvent.toolCallId, () => ({
						id: streamEvent.toolCallId,
						toolType: 'read_file',
						status: 'running',
						args: streamEvent.args,
						details: null,
						content: ''
					}));
				} else if (streamEvent.toolType === 'exec_command') {
					upsertToolPart(assistantId, streamEvent.toolCallId, () => ({
						id: streamEvent.toolCallId,
						toolType: 'exec_command',
						status: 'running',
						args: streamEvent.args,
						details: null,
						content: ''
					}));
				} else {
					upsertToolPart(assistantId, streamEvent.toolCallId, () => ({
						id: streamEvent.toolCallId,
						toolType: 'unknown',
						toolName: streamEvent.toolName,
						status: 'running',
						args: streamEvent.args,
						details: null,
						content: ''
					}));
				}

				if (toolExpanded[streamEvent.toolCallId] === undefined) {
					toolExpanded = {
						...toolExpanded,
						[streamEvent.toolCallId]: false
					};
				}

				return;
			}
			case 'tool_call_end': {
				const completedTool = getAssistantTool(assistantId, streamEvent.toolCallId);
				const toolBilledCostUsd = getToolBilledCostUsd({
					streamEvent,
					tool: completedTool
				});

				updateAssistantStats(assistantId, (stats) => {
					if (stats.activeToolCallCount <= 0 || stats.activeToolCallStartedAt === null) {
						return {
							...stats,
							billedCostUsd: addUsd(stats.billedCostUsd, toolBilledCostUsd),
							activeToolCallCount: 0,
							activeToolCallStartedAt: null
						};
					}

					const nextActiveToolCallCount = stats.activeToolCallCount - 1;
					const completedToolWindowDurationMs =
						nextActiveToolCallCount === 0
							? Math.max(0, streamEvent.timestamp - stats.activeToolCallStartedAt)
							: 0;

					return {
						...stats,
						billedCostUsd: addUsd(stats.billedCostUsd, toolBilledCostUsd),
						toolCallDurationMs: stats.toolCallDurationMs + completedToolWindowDurationMs,
						activeToolCallCount: nextActiveToolCallCount,
						activeToolCallStartedAt:
							nextActiveToolCallCount === 0 ? null : stats.activeToolCallStartedAt
					};
				});

				if (streamEvent.toolType === 'read_file') {
					upsertToolPart(assistantId, streamEvent.toolCallId, (tool) => ({
						id: streamEvent.toolCallId,
						toolType: 'read_file',
						status: streamEvent.isError ? 'error' : 'done',
						args: tool?.toolType === 'read_file' ? tool.args : null,
						details: streamEvent.details,
						content: streamEvent.content
					}));
				} else if (streamEvent.toolType === 'exec_command') {
					upsertToolPart(assistantId, streamEvent.toolCallId, (tool) => ({
						id: streamEvent.toolCallId,
						toolType: 'exec_command',
						status: streamEvent.isError ? 'error' : 'done',
						args: tool?.toolType === 'exec_command' ? tool.args : null,
						details: streamEvent.details,
						content: streamEvent.content
					}));
				} else {
					upsertToolPart(assistantId, streamEvent.toolCallId, (tool) => ({
						id: streamEvent.toolCallId,
						toolType: 'unknown',
						toolName: tool?.toolType === 'unknown' ? tool.toolName : streamEvent.toolName,
						status: streamEvent.isError ? 'error' : 'done',
						args: tool?.toolType === 'unknown' ? tool.args : null,
						details: streamEvent.details,
						content: streamEvent.content
					}));
				}

				return;
			}
			case 'done':
				updateAssistantMessage(assistantId, (message) => ({
					...message,
					pending: false
				}));
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					liveUsage: null,
					completedAt: stats.completedAt ?? streamEvent.timestamp,
					activeToolCallCount: 0,
					activeToolCallStartedAt: null
				}));
				isStreaming = false;
				return;
		}
	}

	function getPersistedMessageDelta(streamEvent: AgentPromptStreamEvent) {
		switch (streamEvent.type) {
			case 'assistant_message':
				return 1;
			case 'tool_call_end':
				if (streamEvent.toolType === 'unknown' && streamEvent.excludeFromPersistedCount === true) {
					return 0;
				}

				return 1;
			default:
				return 0;
		}
	}

	async function consumeAgentStream(response: Response, assistantId: string) {
		if (!response.body) {
			throw new Error('The agent stream did not return a readable body.');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let completed = false;
		let persistedMessageCount = 1;

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';

			for (const block of blocks) {
				const event = parseAgentStreamEvent(block);

				if (event) {
					handleStreamEvent(assistantId, event);
					persistedMessageCount += getPersistedMessageDelta(event);
					completed = completed || event.type === 'done';
				}
			}
		}

		buffer += decoder.decode();

		for (const block of buffer.split('\n\n')) {
			const event = parseAgentStreamEvent(block);

			if (event) {
				handleStreamEvent(assistantId, event);
				persistedMessageCount += getPersistedMessageDelta(event);
				completed = completed || event.type === 'done';
			}
		}

		return {
			completed,
			persistedMessageCount
		};
	}

	async function submitPrompt(promptOverride = draft, options?: { clearDraft?: boolean }) {
		const prompt = promptOverride.trim();
		const clearDraft = options?.clearDraft ?? true;

		if (!prompt || isStreaming) {
			return;
		}

		errorMessage = null;

		let activeThreadId: string;

		try {
			activeThreadId = await ensureThreadId();
		} catch (error) {
			const message = getHumanErrorMessage(error, 'Failed to create the thread.');
			errorMessage = message;
			appendSystemMessage(message);
			return;
		}

		isStreaming = true;
		upScrollCursor = null;

		const controller = new AbortController();
		currentRequest = controller;

		const userMessageId = createId();
		const assistantId = createId();
		const nextUserSequence = getThreadPersistedMessageCount(activeThreadId);
		const shouldScrollToSubmittedMessage = nextUserSequence > 0;

		messages = [
			...messages,
			{
				id: userMessageId,
				role: 'user',
				content: prompt,
				createdAt: Date.now(),
				persistedSequence: nextUserSequence
			},
			{
				id: assistantId,
				role: 'assistant',
				parts: [],
				createdAt: Date.now(),
				pending: true,
				stats: createAssistantStats(selectedModel)
			}
		];

		if (clearDraft) {
			draft = '';
		}

		if (shouldScrollToSubmittedMessage) {
			await tick();
			scrollContainer
				?.querySelector(`[data-message-id="${userMessageId}"]`)
				?.scrollIntoView({ behavior: 'instant', block: 'start' });
		}

		try {
			const response = await fetch(resolvedAgentApiPath, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ threadId: activeThreadId, prompt, modelId: selectedModelId }),
				signal: controller.signal
			});

			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as {
					message?: string;
				} | null;
				throw new Error(payload?.message ?? 'The agent stream request failed.');
			}

			const streamResult = await consumeAgentStream(response, assistantId);

			if (streamResult.completed) {
				setThreadPersistedMessageCount(
					activeThreadId,
					nextUserSequence + streamResult.persistedMessageCount
				);
			}
		} catch (error) {
			if (controller.signal.aborted) {
				updateAssistantMessage(assistantId, (message) => ({
					...message,
					pending: false
				}));
				return;
			}

			const message = getHumanErrorMessage(error, 'The chat request failed.');
			errorMessage = message;
			updateAssistantMessage(assistantId, (current) => ({ ...current, pending: false }));
			appendSystemMessage(message);
		} finally {
			if (currentRequest === controller) {
				currentRequest = null;
			}

			isStreaming = false;
			void tick().then(() => {
				composer?.focus();
			});
		}
	}

	function stopStreaming() {
		currentRequest?.abort();
		currentRequest = null;
		isStreaming = false;
	}

	function clearConversationUiState() {
		errorMessage = null;
		toolExpanded = {};
		toolGroupExpanded = {};
		messageCopyState = {};
		fullThreadCopyState = 'idle';
	}

	async function retryUserMessage(message: UserMessage) {
		if (
			isStreaming ||
			retryingMessageId !== null ||
			!threadId ||
			message.persistedSequence === null
		) {
			return;
		}

		const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);

		if (messageIndex === -1) {
			return;
		}

		const trimmedMessages = cloneChatMessages(messages.slice(0, messageIndex));
		retryingMessageId = message.id;

		try {
			await convex.mutation(api.authed.agentThreads.rewindThread, {
				threadId,
				sequence: message.persistedSequence
			});

			setThreadPersistedMessageCount(threadId, message.persistedSequence);
			clearConversationUiState();
			messages = trimmedMessages;
			threadMessageCache[threadId] = cloneChatMessages(trimmedMessages);
			await submitPrompt(message.content, { clearDraft: false });
		} catch (error) {
			const retryError = getHumanErrorMessage(
				error,
				'Failed to retry the selected prompt.'
			);
			errorMessage = retryError;
			appendSystemMessage(retryError);
		} finally {
			retryingMessageId = null;
		}
	}

	function updateMentionState() {
		if (!composer) {
			mentionState = null;
			return;
		}

		const selectionStart = composer.selectionStart ?? draft.length;
		const prefix = draft.slice(0, selectionStart);
		const match = /(^|[\s([{"'])@([a-zA-Z0-9-]*)$/u.exec(prefix);

		if (!match) {
			mentionState = null;
			mentionMenuIndex = 0;
			return;
		}

		const query = match[2] ?? '';

		mentionState = {
			query,
			start: selectionStart - query.length - 1,
			end: selectionStart
		};
		mentionMenuIndex = 0;
	}

	async function insertMention(slug: string) {
		if (!mentionState || !composer || !slug) {
			return;
		}

		const mention = `@${slug}`;
		const suffix = draft.slice(mentionState.end);
		const needsSpace = suffix.length > 0 && !/^\s/u.test(suffix);
		const nextDraft = `${draft.slice(0, mentionState.start)}${mention}${needsSpace ? ' ' : ''}${suffix}`;
		const nextCaretPosition = mentionState.start + mention.length + (needsSpace ? 1 : 0);

		draft = nextDraft;
		mentionState = null;
		mentionMenuIndex = 0;
		await tick();
		composer.focus();
		composer.setSelectionRange(nextCaretPosition, nextCaretPosition);
	}

	function handleComposerInput() {
		updateMentionState();
	}

	function handleComposerClick() {
		updateMentionState();
	}

	function handleComposerKeyup(event: KeyboardEvent) {
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter') {
			return;
		}

		updateMentionState();
	}

	function handleComposerKeydown(event: KeyboardEvent) {
		if (mentionState && resourceMentionSuggestions.length > 0) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				mentionMenuIndex = (mentionMenuIndex + 1) % resourceMentionSuggestions.length;
				return;
			}

			if (event.key === 'ArrowUp') {
				event.preventDefault();
				mentionMenuIndex =
					(mentionMenuIndex - 1 + resourceMentionSuggestions.length) %
					resourceMentionSuggestions.length;
				return;
			}

			if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
				event.preventDefault();
				void insertMention(resourceMentionSuggestions[mentionMenuIndex]?.slug ?? '');
				return;
			}
		}

		if (event.key === 'Escape' && mentionState !== null) {
			mentionState = null;
			mentionMenuIndex = 0;
			return;
		}

		if (event.key !== 'Enter' || event.shiftKey) {
			return;
		}

		event.preventDefault();
		void submitPrompt();
	}

	function selectModel(id: AgentModelId) {
		selectedModelId = id;
		modelPickerOpen = false;
	}

	function handleModelPickerKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			modelPickerOpen = false;
		}
	}

	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}

		if (document.activeElement && document.activeElement !== document.body) {
			return;
		}

		if (event.key.length !== 1) {
			return;
		}

		composer?.focus();
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="flex min-h-0 flex-1 flex-col">
	<div class="relative min-h-0 flex-1">
		<div
			bind:this={scrollContainer}
			class="bc-chatPattern bc-scrollbar absolute inset-0 overflow-y-auto"
		>
			<div class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-2 p-4">
				{#if errorMessage}
					<div class="chat-message chat-message-system">
						<div class="space-y-1">
							<p class="text-sm font-medium text-[hsl(var(--bc-error))]">Stream error</p>
							<p class="bc-muted text-sm">{errorMessage}</p>
						</div>
					</div>
				{/if}

				{#if messages.length === 0 && threadId}
					<div class="chat-message chat-message-system bc-reveal">
						<p class="bc-muted text-sm leading-7">
							{threadQuery.isLoading
								? 'Loading thread...'
								: 'Send a message to continue this thread.'}
						</p>
					</div>
				{:else if messages.length === 0}
					<div class="chat-message chat-message-system bc-reveal">
						<p class="bc-muted text-sm leading-7">Start a new conversation.</p>
					</div>
				{/if}

				{#each messages as message (message.id)}
					{#if message.role === 'user'}
						<div class="chat-message chat-message-user" data-message-id={message.id}>
							<div class="mb-1 text-xs font-medium text-[hsl(var(--bc-muted))]">You</div>
							<p class="text-sm leading-6 whitespace-pre-wrap">{message.content}</p>
							<div class="chat-message-actions">
								<button
									type="button"
									class="chat-message-action"
									onclick={() => void retryUserMessage(message)}
									disabled={isStreaming ||
										retryingMessageId !== null ||
										message.persistedSequence === null}
								>
									{retryingMessageId === message.id ? 'Retrying...' : 'Retry'}
								</button>
							</div>
						</div>
					{:else if message.role === 'assistant'}
						<div class="chat-message chat-message-assistant" data-message-id={message.id}>
							<div class="mb-2 flex flex-wrap items-center gap-2">
								<div class="text-xs font-medium text-[hsl(var(--bc-success))]">Agent</div>
								<div class="assistant-meta-chip">{getAssistantModelLabel(message)}</div>
								{#if message.pending}
									<div class="assistant-meta-chip assistant-meta-chip-live">Running</div>
								{/if}
							</div>

							{#each groupMessageParts(message.parts) as segment (segment.type === 'text' ? segment.part.id : getToolGroupKey(segment.tools))}
								{#if segment.type === 'text'}
									<MarkdownMessage content={segment.part.content} />
								{:else}
									{@const groupKey = getToolGroupKey(segment.tools)}
									{@const groupStatus = getToolGroupStatus(segment.tools)}
									<div class={`tool-group ${getToolGroupTypeClass(segment.tools)}`}>
										<button
											type="button"
											class="tool-group-bar"
											onclick={() => toggleToolGroup(groupKey)}
										>
											<div class="tool-group-bar-left">
												<span
													class={`tool-dot ${groupStatus === 'running' ? 'tool-dot-pending' : groupStatus === 'error' ? 'tool-dot-error' : 'tool-dot-completed'}`}
												></span>
												<span class="tool-group-bar-label">
													{getToolGroupLabel(segment.tools)}
												</span>
											</div>
											<div class="tool-group-bar-right">
												<span class="tool-group-bar-count">
													{segment.tools.length}
													{segment.tools.length === 1 ? 'call' : 'calls'}
												</span>
												<svg
													class="tool-group-chevron"
													class:tool-group-chevron-open={toolGroupExpanded[groupKey]}
													width="12"
													height="12"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2.5"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="m6 9 6 6 6-6" />
												</svg>
											</div>
										</button>

										{#if toolGroupExpanded[groupKey]}
											<div class="tool-group-panel" transition:slide={{ duration: 150 }}>
												{#each segment.tools as tool (tool.id)}
													<div
														class={`tool-card ${toolExpanded[tool.id] ? 'tool-card-open' : ''} ${getToolTypeClass(tool)}`}
													>
														<button
															type="button"
															class="tool-card-header"
															onclick={() => toggleTool(tool.id)}
														>
															<div class="tool-card-summary">
																<span
																	class={`tool-dot ${tool.status === 'running' ? 'tool-dot-pending' : tool.status === 'error' ? 'tool-dot-error' : 'tool-dot-completed'}`}
																></span>
																<div class="space-y-1 text-left">
																	<div class="tool-inline-name">
																		{getToolLabel(tool)}
																	</div>
																	<div class="bc-muted text-xs">
																		{getToolSummary(tool)}
																	</div>
																</div>
															</div>
															<div class="tool-card-toggle">
																{toolExpanded[tool.id] ? 'Hide' : 'Show'}
															</div>
														</button>

														{#if toolExpanded[tool.id]}
															<div class="tool-card-body">
																{#if tool.toolType === 'read_file'}
																	<div class="tool-meta-grid">
																		<div>
																			<div class="tool-meta-label">Path</div>
																			<div class="tool-meta-value">
																				{tool.details?.path ?? tool.args?.path ?? 'Unknown file'}
																			</div>
																		</div>
																		<div>
																			<div class="tool-meta-label">Range</div>
																			<div class="tool-meta-value">
																				{getReadFileMeta(tool.details)}
																			</div>
																		</div>
																	</div>

																	{#if tool.details && getReadFileLines(tool.details).length > 0}
																		<div class="tool-file-view bc-scrollbar">
																			{#each getReadFileLines(tool.details) as line (line.number)}
																				<div class="tool-file-line">
																					<span class="tool-file-gutter">{line.number}</span>
																					<code class="tool-file-code">{line.content || ' '}</code>
																				</div>
																			{/each}
																		</div>
																	{:else}
																		<div class="tool-empty-state">
																			{tool.content || 'No file content returned.'}
																		</div>
																	{/if}
																{:else if tool.toolType === 'exec_command'}
																	<div class="tool-meta-grid">
																		<div class="tool-meta-span">
																			<div class="tool-meta-label">Command</div>
																			<div class="tool-meta-value">
																				{tool.details?.command ??
																					tool.args?.command ??
																					'Unknown command'}
																			</div>
																		</div>
																		<div>
																			<div class="tool-meta-label">Working directory</div>
																			<div class="tool-meta-value">
																				{tool.details?.cwd ?? tool.args?.cwd ?? '/workspace'}
																			</div>
																		</div>
																		<div>
																			<div class="tool-meta-label">Exit code</div>
																			<div class="tool-meta-value">
																				{tool.details?.exitCode ?? 'unknown'}
																			</div>
																		</div>
																	</div>

																	{#if tool.details?.stdout}
																		<div class="tool-output-block">
																			<div class="tool-output-label">stdout</div>
																			<pre class="tool-output-pre bc-scrollbar">{tool.details
																					.stdout}</pre>
																		</div>
																	{/if}

																	{#if tool.details?.stderr}
																		<div class="tool-output-block">
																			<div class="tool-output-label">stderr</div>
																			<pre class="tool-output-pre bc-scrollbar">{tool.details
																					.stderr}</pre>
																		</div>
																	{/if}

																	{#if !tool.details?.stdout && !tool.details?.stderr}
																		<div class="tool-output-block">
																			<div class="tool-output-label">output</div>
																			<pre class="tool-output-pre bc-scrollbar">
																					{tool.content || 'No command output returned.'}
																				</pre>
																		</div>
																	{/if}
																{:else}
																	<div class="tool-output-block">
																		<div class="tool-output-label">Arguments</div>
																		<pre class="tool-output-pre bc-scrollbar">{prettyJson(
																				tool.args
																			)}</pre>
																	</div>
																	<div class="tool-output-block">
																		<div class="tool-output-label">Details</div>
																		<pre class="tool-output-pre bc-scrollbar">{prettyJson(
																				tool.details
																			)}</pre>
																	</div>
																	{#if tool.content}
																		<div class="tool-output-block">
																			<div class="tool-output-label">Content</div>
																			<pre class="tool-output-pre bc-scrollbar">{tool.content}</pre>
																		</div>
																	{/if}
																{/if}
															</div>
														{/if}
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{/if}
							{/each}

							{#if message.parts.length === 0 && message.pending}
								<p class="bc-muted text-sm">Waiting for the first tokens...</p>
							{/if}

							{#if getAssistantUsage(message)}
								{@const usage = getAssistantUsage(message)}
								{@const billedCostUsd = getAssistantBilledCostUsd(message)}
								{@const outputTokensPerSecond = getAssistantOutputTokensPerSecond(message)}
								{#if usage}
									<div class="assistant-stats">
										<div class="assistant-stat">{formatTokenCount(usage.input)} in</div>
										<div class="assistant-stat">{formatTokenCount(usage.output)} out</div>
										<div class="assistant-stat">{formatTokenCount(usage.totalTokens)} total</div>
										{#if usage.cacheRead > 0}
											<div class="assistant-stat">
												{formatTokenCount(usage.cacheRead)} cached
											</div>
										{/if}
										{#if outputTokensPerSecond}
											<div class="assistant-stat">
												{tokenRateFormatter.format(outputTokensPerSecond)} tok/s
											</div>
										{/if}
										<div class="assistant-stat">
											{isPricingVisible(message) ? formatCost(billedCostUsd || usage.cost.total) : 'Cost n/a'}
										</div>
									</div>
								{/if}
							{/if}

							{#if !message.pending && message.parts.length > 0}
								<div class="mt-3">
									<button
										type="button"
										class="bc-btn px-3 py-1.5 text-[11px]"
										onclick={() => void copyAttachedMessage(message)}
									>
										{messageCopyState[message.id] === 'copied'
											? 'Copied'
											: messageCopyState[message.id] === 'error'
												? 'Copy failed'
												: 'Copy to clipboard'}
									</button>
								</div>
							{/if}
						</div>
					{:else}
						<div class="chat-message chat-message-system">
							<p class="text-sm leading-7">{message.content}</p>
						</div>
					{/if}
				{/each}

				{#if messages.length > 0}
					<div class="flex justify-center pt-4">
						<button type="button" class="bc-btn" onclick={() => void copyFullThread()}>
							{fullThreadCopyState === 'copied'
								? 'Copied'
								: fullThreadCopyState === 'error'
									? 'Copy failed'
									: 'Copy thread to clipboard'}
						</button>
					</div>
				{/if}

				{#if messages.length > 0}
					<div class="sticky bottom-4 flex justify-center gap-2">
						<button
							type="button"
							class="bc-btn bg-[hsl(var(--bc-surface))] px-3 py-2"
							onclick={scrollToPreviousExchange}
							title="Jump to previous message"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="m18 15-6-6-6 6" />
							</svg>
						</button>
						<button
							type="button"
							class="bc-btn bg-[hsl(var(--bc-surface))] px-3 py-2"
							onclick={() => scrollToBottom()}
							title="Jump to bottom"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="m6 9 6 6 6-6" />
							</svg>
						</button>
					</div>
				{/if}
			</div>
			<div class="h-16"></div>
		</div>
	</div>

	<div class="chat-input-container">
		<div class="input-wrapper">
			{#if mentionState !== null}
				<div class="absolute inset-x-0 bottom-full z-40 mb-3">
					<div
						class="overflow-hidden rounded-3xl border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] shadow-[0_-12px_40px_hsl(var(--bc-shadow)/0.35)]"
					>
						{#if resourceMentionSuggestions.length > 0}
							<div
								class="border-b border-[hsl(var(--bc-border))] px-4 py-3 text-xs tracking-[0.16em] text-[hsl(var(--bc-fg-muted))] uppercase"
							>
								Resources
							</div>
							<div class="max-h-72 overflow-y-auto">
								{#each resourceMentionSuggestions as resource, index (resource.id)}
									<button
										type="button"
										class={[
											'w-full border-b border-[hsl(var(--bc-border))/0.45] px-4 py-3 text-left last:border-b-0',
											index === mentionMenuIndex && 'bg-[hsl(var(--bc-surface-2))]'
										]}
										onclick={() => void insertMention(resource.slug)}
									>
										<div class="flex items-start justify-between gap-3">
											<div class="space-y-1">
												<div class="flex flex-wrap items-center gap-2">
													<span class="font-medium">{resource.name}</span>
													<span class="text-xs text-[hsl(var(--bc-fg-muted))]">
														@{resource.slug}
													</span>
												</div>
												{#if resource.notes}
													<p class="text-sm text-[hsl(var(--bc-fg-muted))]">
														{resource.notes}
													</p>
												{/if}
											</div>
											<span class="shrink-0 text-xs text-[hsl(var(--bc-fg-muted))]">
												{resource.itemCount} items
											</span>
										</div>
									</button>
								{/each}
							</div>
						{:else}
							<div class="px-4 py-4 text-sm text-[hsl(var(--bc-fg-muted))]">
								No matching resources yet.
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<textarea
				bind:this={composer}
				bind:value={draft}
				class="chat-input bc-scrollbar"
				rows="1"
				placeholder="Ask the agent to inspect code, run a command, or read a file..."
				disabled={isStreaming || retryingMessageId !== null}
				oninput={handleComposerInput}
				onclick={handleComposerClick}
				onkeydown={handleComposerKeydown}
				onkeyup={handleComposerKeyup}
			></textarea>

			{#if isStreaming}
				<button type="button" class="send-btn" onclick={stopStreaming} aria-label="Stop streaming">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
						<rect x="6" y="6" width="12" height="12" rx="2" />
					</svg>
				</button>
			{:else}
				<button
					type="button"
					class="send-btn"
					onclick={() => void submitPrompt()}
					disabled={!draft.trim() || retryingMessageId !== null}
					aria-label="Send message"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M5 12h14" />
						<path d="m12 5 7 7-7 7" />
					</svg>
				</button>
			{/if}
		</div>

		<div class="input-footer">
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="model-picker" onkeydown={handleModelPickerKeydown}>
				<button
					type="button"
					class="model-picker-trigger"
					disabled={isStreaming || retryingMessageId !== null}
					onclick={() => (modelPickerOpen = !modelPickerOpen)}
				>
					<span>{selectedModel.label}</span>
					<svg
						class="model-picker-chevron"
						class:model-picker-chevron-open={modelPickerOpen}
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="m6 9 6 6 6-6" />
					</svg>
				</button>

				{#if modelPickerOpen}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div class="model-picker-backdrop" onclick={() => (modelPickerOpen = false)}></div>
					<div class="model-picker-menu">
						{#each agentModelOptions as option (option.id)}
							<button
								type="button"
								class="model-picker-option"
								class:model-picker-option-active={option.id === selectedModelId}
								onclick={() => selectModel(option.id)}
							>
								<span class="model-picker-option-label">{option.label}</span>
								<span class="model-picker-option-desc">{option.description}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<p class="bc-muted">Shift+Enter · Enter sends</p>

			{#if lastAssistantText.trim()}
				<span class="bc-muted ml-auto tabular-nums">
					{lastAssistantText.length.toLocaleString()} chars
				</span>
			{/if}
		</div>
	</div>
</div>

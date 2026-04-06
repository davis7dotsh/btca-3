<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Usage } from '@mariozechner/pi-ai';
	import type { Id } from '@btca/convex/data-model';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { api } from '@btca/convex/api';
	import { createUploadThing } from '$lib/uploadthing';
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
	import { extractTaggedResourceNames, normalizeResourceName } from '$lib/resources';
	import type { AgentModelId, AgentModelOption } from '$lib/models';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import type {
		ActiveAgentRunResponse,
		AgentReasoningContentPart,
		AgentRunStartResponse,
		AgentRunMetrics,
		AgentPromptStreamEvent,
		AgentToolCallEndEvent,
		StoredAgentThreadAttachment,
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

	interface ResourceListItem {
		id: string;
		name: string;
		createdAt: number;
		updatedAt: number;
		itemCount: number;
	}

	interface TaggedThreadResource {
		id: string | null;
		name: string;
		itemCount: number | null;
	}

	type QueryState<T> = {
		data: T | undefined;
		isLoading: boolean;
		error: unknown;
	};

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

	interface ReasoningPart {
		id: string;
		type: 'reasoning';
		content: string;
		status: 'running' | 'done';
		thinkingSignature?: string;
		redacted?: boolean;
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

	type ContentPart = TextPart | ReasoningPart | ToolPart;

	interface TextSegment {
		type: 'text';
		part: TextPart;
	}

	interface ReasoningSegment {
		type: 'reasoning';
		part: ReasoningPart;
	}

	interface ToolGroupSegment {
		type: 'tool_group';
		tools: ToolCallState[];
	}

	type MessageSegment = TextSegment | ReasoningSegment | ToolGroupSegment;
	type AttachmentId = Id<'v2_agentThreadAttachments'>;
	type AttachmentStatus = 'uploading' | 'pending' | 'attached' | 'removing';

	interface ThreadAttachment {
		id: string;
		fileKey: string | null;
		ufsUrl: string;
		previewUrl: string;
		fileName: string;
		fileSize: number;
		mimeType: string;
		status: AttachmentStatus;
		messageSequence: number | null;
		createdAt: number;
		updatedAt: number;
	}

	interface UserMessage {
		id: string;
		role: 'user';
		content: string;
		attachments: ThreadAttachment[];
		createdAt: number;
		persistedSequence: number | null;
	}

	interface AssistantMessage {
		id: string;
		role: 'assistant';
		parts: ContentPart[];
		pending: boolean;
		canceled: boolean;
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
		generationStartedAt: number | null;
		completedUsage: Usage | null;
		liveUsage: Usage | null;
		billedCostUsd: number;
		runMetrics: AgentRunMetrics | null;
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

	interface RunResumeState {
		runId: string;
		lastEventId: string | null;
	}

	interface EditPromptState {
		messageId: string;
		persistedSequence: number;
		attachmentIds: AttachmentId[];
	}

	const authContext = getAuthContext();
	const convex = browser ? useConvexClient() : null;
	const attachmentUploader = createUploadThing('agentAttachment', {});
	const RUN_RESUME_STORAGE_KEY = 'bc-agent-run-resume';
	const createId = () => crypto.randomUUID();
	const createThreadId = () => `chat-${crypto.randomUUID()}`;
	const isAgentModelId = (value: string | null | undefined): value is AgentModelId =>
		value !== null && value !== undefined && agentModelOptions.some((option) => option.id === value);

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
	const cloneThreadAttachment = (attachment: ThreadAttachment): ThreadAttachment => ({
		...attachment
	});
	const cloneThreadAttachments = (value: ThreadAttachment[]) => value.map(cloneThreadAttachment);
	const cloneStoredAttachment = (attachment: StoredAgentThreadAttachment): ThreadAttachment => ({
		id: attachment.id,
		fileKey: attachment.fileKey,
		ufsUrl: attachment.ufsUrl,
		previewUrl: attachment.ufsUrl,
		fileName: attachment.fileName,
		fileSize: attachment.fileSize,
		mimeType: attachment.mimeType,
		status: attachment.status,
		messageSequence: attachment.messageSequence,
		createdAt: attachment.createdAt,
		updatedAt: attachment.updatedAt
	});
	const revokeAttachmentPreviewUrl = (attachment: ThreadAttachment) => {
		if (attachment.previewUrl.startsWith('blob:')) {
			URL.revokeObjectURL(attachment.previewUrl);
		}
	};
	const fileListFromDataTransfer = (dataTransfer: DataTransfer | null) =>
		dataTransfer ? Array.from(dataTransfer.files) : [];
	const fileListFromClipboard = (clipboardData: DataTransfer | null) => {
		if (!clipboardData) {
			return [];
		}

		const clipboardFiles = Array.from(clipboardData.files).filter((file) => file.type.startsWith('image/'));

		if (clipboardFiles.length > 0) {
			return clipboardFiles;
		}

		return Array.from(clipboardData.items)
			.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
			.map((item) => item.getAsFile())
			.filter((file): file is File => file !== null);
	};
	const isImageFile = (file: File) =>
		file.type.startsWith('image/') && !file.type.startsWith('image/video');
	const normalizeUploadFiles = (value: FileList | readonly File[] | null) =>
		value ? (Array.isArray(value) ? [...value] : Array.from(value)) : [];
	const getAttachmentExtension = (attachment: ThreadAttachment) => {
		const fileNameParts = attachment.fileName.split('.');
		const fileNameExtension = fileNameParts.length > 1 ? fileNameParts[fileNameParts.length - 1] : '';

		if (fileNameExtension) {
			return fileNameExtension.slice(0, 4).toUpperCase();
		}

		const mimeSubtype = attachment.mimeType.split('/')[1] ?? 'IMG';
		return mimeSubtype.slice(0, 4).toUpperCase();
	};
	const getAttachmentStatusLabel = (attachment: ThreadAttachment) => {
		if (attachment.status === 'uploading') {
			return 'Uploading';
		}

		if (attachment.status === 'removing') {
			return 'Removing';
		}

		return 'Ready';
	};
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
		generationStartedAt: null,
		completedUsage: null,
		liveUsage: null,
		billedCostUsd: 0,
		runMetrics: null,
		completedAt: null,
		toolCallDurationMs: 0,
		activeToolCallCount: 0,
		activeToolCallStartedAt: null
	});
	const cloneAssistantStats = (stats: AssistantStats): AssistantStats => ({
		...stats,
		model: stats.model ? { ...stats.model } : null,
		completedUsage: cloneUsage(stats.completedUsage),
		liveUsage: cloneUsage(stats.liveUsage),
		runMetrics: stats.runMetrics ? { ...stats.runMetrics } : null
	});
	const getAssistantUsage = (message: AssistantMessage) =>
		addUsage(message.stats.completedUsage, message.stats.liveUsage);
	const getAssistantBilledCostUsd = (message: AssistantMessage) =>
		message.stats.runMetrics?.priceUsd ?? message.stats.billedCostUsd;
	const getAssistantTotalToolCalls = (message: AssistantMessage) =>
		message.stats.runMetrics?.totalToolCalls ?? null;
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
	const estimateTokenCount = (value: string) => {
		const trimmed = value.trim();

		if (trimmed.length === 0) {
			return 0;
		}

		const wordCount = trimmed.split(/\s+/u).filter(Boolean).length;
		const punctuationCount = (trimmed.match(/[^\w\s]/gu) ?? []).length;
		return Math.max(wordCount + Math.ceil(punctuationCount / 2), Math.ceil(trimmed.length / 4));
	};
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
		const startedAt = message.stats.generationStartedAt ?? message.createdAt;
		const completedAt = message.pending ? Date.now() : message.stats.completedAt;

		if (!completedAt || completedAt <= startedAt) {
			return null;
		}

		const activeGenerationDurationMs = completedAt - startedAt - getAssistantToolDurationMs(message);

		if (activeGenerationDurationMs <= 0) {
			return null;
		}

		return activeGenerationDurationMs;
	};
	const getAssistantOutputTokensPerSecond = (message: AssistantMessage) => {
		if (message.stats.runMetrics?.outputTokensPerSecond !== null) {
			return message.stats.runMetrics?.outputTokensPerSecond ?? null;
		}

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

		if (message.stats.runMetrics !== null) {
			return true;
		}

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
			} else if (part.type === 'reasoning') {
				if (part.content.trim().length > 0 || part.status === 'running') {
					segments.push({ type: 'reasoning', part });
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
	const getReasoningLabel = (part: ReasoningPart) =>
		part.status === 'running' ? 'Reasoning summary' : 'Reasoning';

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
		part.type === 'text'
			? { ...part }
			: part.type === 'reasoning'
				? { ...part }
				: { type: 'tool', tool: cloneToolState(part.tool) };

	const cloneChatMessage = (message: ChatMessage): ChatMessage => {
		switch (message.role) {
			case 'user':
				return { ...message, attachments: cloneThreadAttachments(message.attachments) };
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
			canceled: false,
			createdAt,
			stats: createAssistantStats()
		};

		value.push(nextAssistant);
		return nextAssistant;
	};

	const hydrateStoredThreadMessages = (
		storedMessages: readonly StoredAgentThreadMessage[],
		storedAttachments: readonly StoredAgentThreadAttachment[]
	) => {
		const hydratedMessages: ChatMessage[] = [];
		const toolStates: Record<string, ToolCallState> = {};
		const attachmentsBySequence = new Map<number, ThreadAttachment[]>();

		for (const attachment of storedAttachments) {
			if (attachment.messageSequence === null) {
				continue;
			}

			const current = attachmentsBySequence.get(attachment.messageSequence) ?? [];
			current.push(cloneStoredAttachment(attachment));
			attachmentsBySequence.set(attachment.messageSequence, current);
		}

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
					attachments: cloneThreadAttachments(
						attachmentsBySequence.get(storedMessage.sequence) ?? []
					),
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
				assistantMessage.canceled = parsedMessage.stopReason === 'aborted';
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
					generationStartedAt:
						assistantMessage.stats.generationStartedAt ?? parsedMessage.timestamp,
					completedUsage: addUsage(assistantMessage.stats.completedUsage, parsedMessage.usage),
					liveUsage: null,
					billedCostUsd: addUsd(
						assistantMessage.stats.billedCostUsd,
						parsedMessage.runMetrics?.priceUsd ?? parsedMessage.usage.cost.total
					),
					runMetrics: parsedMessage.runMetrics ?? assistantMessage.stats.runMetrics,
					completedAt: parsedMessage.timestamp,
					toolCallDurationMs: assistantMessage.stats.toolCallDurationMs,
					activeToolCallCount: 0,
					activeToolCallStartedAt: null
				};

				if (parsedMessage.errorMessage?.trim() && parsedMessage.stopReason !== 'aborted') {
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

					if (isRecord(part) && part.type === 'thinking' && typeof part.thinking === 'string') {
						assistantMessage.parts.push({
							id: createId(),
							type: 'reasoning',
							content: part.thinking,
							status: 'done',
							...(typeof part.thinkingSignature === 'string'
								? { thinkingSignature: part.thinkingSignature }
								: {}),
							...(typeof part.redacted === 'boolean' ? { redacted: part.redacted } : {})
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
	let selectedModelId = $state<AgentModelId | null>(null);
	let threadId = $state<string | null>(page.params.id ?? null);
	let errorMessage = $state<string | null>(null);
	let isSubmittingPrompt = $state(false);
	let isStreaming = $state(false);
	let toolExpanded = $state<Record<string, boolean>>({});
	let toolGroupExpanded = $state<Record<string, boolean>>({});
	let reasoningExpanded = $state<Record<string, boolean>>({});
	let composer = $state<HTMLTextAreaElement | null>(null);
	let scrollContainer = $state<HTMLDivElement | null>(null);
	let messageCopyState = $state<Record<string, CopyStatus>>({});
	let fullThreadCopyState = $state<CopyStatus>('idle');
	let modelPickerOpen = $state(false);
	let mentionMenuIndex = $state(0);
	let retryingMessageId = $state<string | null>(null);
	let editingMessageId = $state<string | null>(null);
	let editPromptState = $state<EditPromptState | null>(null);
	let editPromptDraft = $state('');
	let editPromptError = $state<string | null>(null);
	let editPromptComposer = $state<HTMLTextAreaElement | null>(null);
	let mentionState = $state<ResourceMentionState | null>(null);
	let dragDepth = $state(0);
	let isChatDropActive = $state(false);
	let threadMessageCache: Record<string, ChatMessage[]> = {};
	let attachments = $state<ThreadAttachment[]>([]);
	let attachmentPreviewErrors = $state<string[]>([]);
	let spotlightAttachment = $state<ThreadAttachment | null>(null);
	let attachmentPicker = $state<HTMLInputElement | null>(null);
	let threadAttachmentCache: Record<string, ThreadAttachment[]> = {};
	let threadPersistedMessageCountCache: Record<string, number> = {};
	let currentRequest: AbortController | null = null;
	let resumingThreadId = $state<string | null>(null);
	let hasLoggedResourceLoadStart = false;
	let pendingDefaultModelId = $state<AgentModelId | null>(null);
	let pendingThreadModelIds = $state<Record<string, AgentModelId>>({});
	let pendingInitialBottomScrollThreadId = $state<string | null>(page.params.id ?? null);

	const threadQuery: QueryState<
		| {
				thread: {
					threadId: string;
					title: string | null;
					sandboxId: string | null;
					selectedModelId: string | null;
					isMcp: boolean;
					status: 'idle' | 'running' | 'error';
					activity: string | null;
					createdAt: number;
					updatedAt: number;
					lastPromptAt: number;
					lastCompletedAt: number | null;
					messageCount: number;
				};
				messages: readonly StoredAgentThreadMessage[];
				attachments: readonly StoredAgentThreadAttachment[];
		  }
		| null
	> = browser
		? useQuery(
				api.authed.agentThreads.get,
				() => (authContext.currentUser && threadId ? { threadId } : 'skip'),
				() => ({ keepPreviousData: true })
			)
		: {
				data: undefined,
				isLoading: false,
				error: null
			};
	const defaultModelQuery: QueryState<{ defaultModelId: string | null }> = browser
		? useQuery(
				api.authed.agentThreads.getDefaultModel,
				() => (authContext.currentUser ? {} : 'skip'),
				() => ({ keepPreviousData: true })
			)
		: {
				data: undefined,
				isLoading: false,
				error: null
			};
	const resourcesQuery: QueryState<
		{
			id: string;
			name: string;
			createdAt: number;
			updatedAt: number;
			itemCount: number;
		}[]
	> = browser
		? useQuery(
				api.authed.resources.list,
				() => (authContext.currentUser ? {} : 'skip'),
				() => ({ keepPreviousData: true })
			)
		: {
				data: undefined,
				isLoading: false,
				error: null
			};
	const resolvedThreadData = $derived(threadQuery.data ?? null);
	const resolvedDefaultModelData = $derived(defaultModelQuery.data);
	const resourceItems = $derived(resourcesQuery.data ?? []);
	const routeThreadId = $derived(page.params.id ?? null);
	const isModelSelectionReady = $derived.by(() => {
		if (!authContext.currentUser) {
			return true;
		}

		if (threadId) {
			return resolvedDefaultModelData !== undefined && resolvedThreadData !== null;
		}

		return resolvedDefaultModelData !== undefined;
	});
	const persistedDefaultModelId = $derived(
		resolvedDefaultModelData === undefined
			? null
			: isAgentModelId(resolvedDefaultModelData.defaultModelId)
				? resolvedDefaultModelData.defaultModelId
				: defaultAgentModelId
	);
	const effectiveDefaultModelId = $derived(pendingDefaultModelId ?? persistedDefaultModelId);
	const persistedThreadModelId = $derived.by(() => {
		const currentThread = resolvedThreadData?.thread;

		if (!threadId || !currentThread || currentThread.threadId !== threadId) {
			return null;
		}

		return isAgentModelId(currentThread.selectedModelId) ? currentThread.selectedModelId : null;
	});
	const effectiveThreadModelId = $derived(
		threadId ? pendingThreadModelIds[threadId] ?? persistedThreadModelId : null
	);
	const resolvedSelectedModelId = $derived(effectiveThreadModelId ?? effectiveDefaultModelId);
	const selectedModel = $derived(
		getAgentModelOption(selectedModelId ?? resolvedSelectedModelId ?? defaultAgentModelId)
	);
	const chatRouteBase = $derived(resolve(routeBase));
	const resolvedAgentApiPath = $derived(resolve(agentApiPath));
	const isSendInFlight = $derived(isSubmittingPrompt || isStreaming);
	const isSubmitPending = $derived(isSubmittingPrompt && !isStreaming);
	const isComposerDisabled = $derived(
		isSendInFlight || retryingMessageId !== null || !isModelSelectionReady
	);
	const isCurrentThreadRunning = $derived(
		isSendInFlight ||
			(resolvedThreadData?.thread.threadId === threadId &&
				resolvedThreadData.thread.status === 'running')
	);
	const assistantMessages = $derived(
		messages.filter((message): message is AssistantMessage => message.role === 'assistant')
	);
	const draftTokenCount = $derived(estimateTokenCount(draft));
	const editDraftTokenCount = $derived(estimateTokenCount(editPromptDraft));
	const lastAssistantMessage = $derived(
		assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null
	);
	const lastAssistantText = $derived(
		lastAssistantMessage ? getAssistantText(lastAssistantMessage) : ''
	);
	const composerAttachments = $derived(
		attachments.filter(
			(attachment) => attachment.status === 'uploading' || attachment.status === 'pending' || attachment.status === 'removing'
		)
	);
	const composerPendingAttachments = $derived(
		composerAttachments.filter((attachment) => attachment.status === 'pending')
	);
	const isAttachmentWorkPending = $derived(
		composerAttachments.some(
			(attachment) => attachment.status === 'uploading' || attachment.status === 'removing'
		)
	);
	const canSubmitPrompt = $derived(
		draft.trim().length > 0 && !isComposerDisabled && !isAttachmentWorkPending
	);
	const hydratedThreadMessages = $derived.by(() => {
		if (!threadId || resolvedThreadData === null) {
			return null;
		}

		if (resolvedThreadData.thread.threadId !== threadId) {
			return null;
		}

		return hydrateStoredThreadMessages(resolvedThreadData.messages, resolvedThreadData.attachments ?? []);
	});
	const hydratedThreadAttachments = $derived.by(() => {
		if (!threadId || resolvedThreadData === null) {
			return null;
		}

		if (resolvedThreadData.thread.threadId !== threadId) {
			return null;
		}

		return (resolvedThreadData.attachments ?? []).map(cloneStoredAttachment);
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
		const query = rawQuery.length === 0 ? '' : normalizeResourceName(rawQuery);
		const rankedMatches = resourceItems
			.map((resource: ResourceListItem) => {
				const name = resource.name.toLowerCase();
				let score = 0;

				if (query.length === 0) {
					score = 1;
				} else if (name === query) {
					score = 6;
				} else if (name.startsWith(query)) {
					score = 2;
				} else if (name.includes(query)) {
					score = 1;
				}

				return { resource, score };
			})
			.filter((candidate: { resource: ResourceListItem; score: number }) => candidate.score > 0)
			.sort(
				(
					left: { resource: ResourceListItem; score: number },
					right: { resource: ResourceListItem; score: number }
				) =>
					right.score - left.score || left.resource.name.localeCompare(right.resource.name)
			)
			.slice(0, 8)
			.map((candidate: { resource: ResourceListItem; score: number }) => candidate.resource);

		return rankedMatches;
	});
	const taggedThreadResources = $derived.by(() => {
		const resourcesByName = new Map(
			resourceItems.map((resource) => [normalizeResourceName(resource.name), resource] as const)
		);
		const taggedResources: TaggedThreadResource[] = [];
		const seenNames = new Set<string>();

		for (const message of messages) {
			if (message.role !== 'user') {
				continue;
			}

			for (const taggedName of extractTaggedResourceNames(message.content)) {
				if (seenNames.has(taggedName)) {
					continue;
				}

				seenNames.add(taggedName);
				const resource = resourcesByName.get(taggedName);
				taggedResources.push({
					id: resource?.id ?? null,
					name: resource?.name ?? taggedName,
					itemCount: resource?.itemCount ?? null
				});
			}
		}

		return taggedResources;
	});
	$effect(() => {
		if (routeThreadId === threadId) {
			return;
		}

		resetTransientConversationState({ clearDraft: false });
		threadId = routeThreadId;
		pendingInitialBottomScrollThreadId = routeThreadId;
		restoreThreadMessages(routeThreadId);
	});

	$effect(() => {
		if (resolvedSelectedModelId === null) {
			return;
		}

		if (selectedModelId === resolvedSelectedModelId) {
			return;
		}

		selectedModelId = resolvedSelectedModelId;
	});

	$effect(() => {
		if (!threadId || messages.length === 0) {
			return;
		}

		threadMessageCache[threadId] = cloneChatMessages(messages);
	});

	$effect(() => {
		if (!threadId) {
			return;
		}

		threadAttachmentCache[threadId] = cloneThreadAttachments(attachments);
	});

	$effect(() => {
		if (!threadId || isStreaming || threadQuery.isLoading || hydratedThreadMessages === null) {
			return;
		}

		threadPersistedMessageCountCache[threadId] = resolvedThreadData?.thread.messageCount ?? 0;

		if (threadMessageCache[threadId] !== undefined) {
			return;
		}

		messages = hydratedThreadMessages;
		threadMessageCache[threadId] = cloneChatMessages(hydratedThreadMessages);
	});

	$effect(() => {
		if (!threadId || isStreaming || threadQuery.isLoading || hydratedThreadAttachments === null) {
			return;
		}

		if (threadAttachmentCache[threadId] !== undefined) {
			return;
		}

		attachments = hydratedThreadAttachments;
		threadAttachmentCache[threadId] = cloneThreadAttachments(hydratedThreadAttachments);
	});

	$effect(() => {
		if (pendingDefaultModelId === null || pendingDefaultModelId !== persistedDefaultModelId) {
			return;
		}

		pendingDefaultModelId = null;
	});

	$effect(() => {
		if (!threadId) {
			return;
		}

		const pendingThreadModelId = pendingThreadModelIds[threadId];

		if (!pendingThreadModelId || pendingThreadModelId !== persistedThreadModelId) {
			return;
		}

		pendingThreadModelIds = Object.fromEntries(
			Object.entries(pendingThreadModelIds).filter(([candidateThreadId]) => candidateThreadId !== threadId)
		) as Record<string, AgentModelId>;
	});

	$effect(() => {
		if (!authContext.currentUser) {
			hasLoggedResourceLoadStart = false;
			return;
		}

		if (resourcesQuery.isLoading) {
			if (!hasLoggedResourceLoadStart) {
				hasLoggedResourceLoadStart = true;
				console.debug('Agent chat resources starting to load', {
					threadId,
					timestamp: Date.now()
				});
			}
			return;
		}

		if (hasLoggedResourceLoadStart && resourceItems.length > 0) {
			hasLoggedResourceLoadStart = false;
			console.debug('Agent chat resources loaded', {
				threadId,
				resourceCount: resourceItems.length,
				timestamp: Date.now()
			});
		}
	});

	$effect(() => {
		if (
			!authContext.currentUser ||
			!threadId ||
			isStreaming ||
			resumingThreadId === threadId ||
			threadQuery.isLoading ||
			resolvedThreadData?.thread.threadId !== threadId ||
			resolvedThreadData.thread.status !== 'running'
		) {
			return;
		}

		void resumeActiveRun(threadId);
	});

	$effect(() => {
		if (!threadId || resolvedThreadData?.thread.threadId !== threadId) {
			return;
		}

		if (resolvedThreadData.thread.status === 'running') {
			return;
		}

		clearRunResumeState(threadId);
	});

	$effect(() => {
		if (
			!scrollContainer ||
			!threadId ||
			pendingInitialBottomScrollThreadId !== threadId ||
			isStreaming
		) {
			return;
		}

		if (messages.length > 0) {
			void tick().then(() => {
				if (
					!scrollContainer ||
					!threadId ||
					pendingInitialBottomScrollThreadId !== threadId ||
					messages.length === 0
				) {
					return;
				}

				scrollToBottom('auto');
				pendingInitialBottomScrollThreadId = null;
			});
			return;
		}

		if (
			!threadQuery.isLoading &&
			resolvedThreadData?.thread.threadId === threadId &&
			resolvedThreadData.thread.messageCount === 0
		) {
			pendingInitialBottomScrollThreadId = null;
		}
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

	function closeEditPromptModal() {
		editPromptState = null;
		editPromptDraft = '';
		editPromptError = null;
		editingMessageId = null;
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
		reasoningExpanded = {};
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
			attachments = [];
			closeEditPromptModal();
			return;
		}

		const cachedMessages = threadMessageCache[nextThreadId];
		const cachedAttachments = threadAttachmentCache[nextThreadId];
		messages = cachedMessages ? cloneChatMessages(cachedMessages) : [];
		attachments = cachedAttachments ? cloneThreadAttachments(cachedAttachments) : [];
		closeEditPromptModal();
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

		if (!convex) {
			throw new Error('Convex client is not ready yet.');
		}

		const nextThreadId = createThreadId();
		const createdThread = await convex.mutation(api.authed.agentThreads.create, {
			threadId: nextThreadId,
			selectedModelId: selectedModelId ?? resolvedSelectedModelId ?? defaultAgentModelId
		});

		threadId = createdThread.threadId;
		threadPersistedMessageCountCache[createdThread.threadId] = 0;
		await syncThreadUrl(createdThread.threadId, true);
		return createdThread.threadId;
	}

	function openAttachmentPicker() {
		if (isComposerDisabled) {
			return;
		}

		attachmentPicker?.click();
	}

	function markAttachmentPreviewError(attachmentId: string) {
		if (attachmentPreviewErrors.includes(attachmentId)) {
			return;
		}

		attachmentPreviewErrors = [...attachmentPreviewErrors, attachmentId];
	}

	function clearAttachmentPreviewError(attachmentId: string) {
		if (!attachmentPreviewErrors.includes(attachmentId)) {
			return;
		}

		attachmentPreviewErrors = attachmentPreviewErrors.filter((id) => id !== attachmentId);
	}

	function openAttachmentSpotlight(attachment: ThreadAttachment) {
		if (!attachment.previewUrl || attachmentPreviewErrors.includes(attachment.id)) {
			return;
		}

		spotlightAttachment = cloneThreadAttachment(attachment);
	}

	function closeAttachmentSpotlight() {
		spotlightAttachment = null;
	}

	async function uploadAttachments(fileList: FileList | readonly File[] | null) {
		if (isComposerDisabled) {
			return;
		}

		const files = normalizeUploadFiles(fileList);

		if (files.length === 0) {
			return;
		}

		const imageFiles = files.filter(isImageFile);
		const rejectedFiles = files.filter((file) => !isImageFile(file));

		if (rejectedFiles.length > 0) {
			const message =
				rejectedFiles.length === 1
					? 'Only image files can be attached here.'
					: 'Only image files can be attached here. Non-image files were skipped.';
			errorMessage = message;
			appendSystemMessage(message);
		}

		if (imageFiles.length === 0) {
			return;
		}

		let activeThreadId: string;

		try {
			activeThreadId = await ensureThreadId();
		} catch (error) {
			const message = getHumanErrorMessage(error, 'Failed to create the thread for attachments.');
			errorMessage = message;
			appendSystemMessage(message);
			return;
		}

		const temporaryAttachments = imageFiles.map((file) => ({
			id: createId(),
			fileKey: null,
			ufsUrl: '',
			previewUrl: URL.createObjectURL(file),
			fileName: file.name,
			fileSize: file.size,
			mimeType: file.type || 'application/octet-stream',
			status: 'uploading' as const,
			messageSequence: null,
			createdAt: Date.now(),
			updatedAt: Date.now()
		}));

		attachments = [...attachments, ...temporaryAttachments];

		try {
			const uploaded = await attachmentUploader.startUpload(imageFiles, {
				threadId: activeThreadId
			});

			const uploadedAttachments = (uploaded ?? [])
				.map((result) => result.serverData)
				.filter(
					(value): value is StoredAgentThreadAttachment =>
						typeof value === 'object' && value !== null && 'id' in value
				)
				.map(cloneStoredAttachment);

			for (const attachment of temporaryAttachments) {
				clearAttachmentPreviewError(attachment.id);
				revokeAttachmentPreviewUrl(attachment);
			}

			attachments = [
				...attachments.filter(
					(candidate) => !temporaryAttachments.some((temporary) => temporary.id === candidate.id)
				),
				...uploadedAttachments
			];
		} catch (error) {
			for (const attachment of temporaryAttachments) {
				clearAttachmentPreviewError(attachment.id);
				revokeAttachmentPreviewUrl(attachment);
			}

			attachments = attachments.filter(
				(candidate) => !temporaryAttachments.some((temporary) => temporary.id === candidate.id)
			);
			const message = getHumanErrorMessage(error, 'Failed to upload the selected attachment.');
			errorMessage = message;
			appendSystemMessage(message);
		} finally {
			if (attachmentPicker) {
				attachmentPicker.value = '';
			}
		}
	}

	async function removeAttachment(attachment: ThreadAttachment) {
		if (attachment.status !== 'pending') {
			return;
		}

		attachments = attachments.map((candidate) =>
			candidate.id === attachment.id ? { ...candidate, status: 'removing' } : candidate
		);

		try {
			const response = await fetch(`/api/agent/attachments/${encodeURIComponent(attachment.id)}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? 'Failed to remove the attachment.');
			}

			revokeAttachmentPreviewUrl(attachment);
			clearAttachmentPreviewError(attachment.id);
			attachments = attachments.filter((candidate) => candidate.id !== attachment.id);
		} catch (error) {
			attachments = attachments.map((candidate) =>
				candidate.id === attachment.id ? { ...candidate, status: 'pending' } : candidate
			);
			const message = getHumanErrorMessage(error, 'Failed to remove the selected attachment.');
			errorMessage = message;
			appendSystemMessage(message);
		}
	}

	function getThreadPersistedMessageCount(targetThreadId: string) {
		const cachedCount = threadPersistedMessageCountCache[targetThreadId];

		if (cachedCount !== undefined) {
			return cachedCount;
		}

		if (resolvedThreadData?.thread.threadId === targetThreadId) {
			return resolvedThreadData.thread.messageCount;
		}

		return 0;
	}

	function setThreadPersistedMessageCount(targetThreadId: string, count: number) {
		threadPersistedMessageCountCache[targetThreadId] = count;
	}

	function readRunResumeStateMap() {
		if (typeof sessionStorage === 'undefined') {
			return {} as Record<string, RunResumeState>;
		}

		try {
			const raw = sessionStorage.getItem(RUN_RESUME_STORAGE_KEY);

			if (!raw) {
				return {} as Record<string, RunResumeState>;
			}

			return JSON.parse(raw) as Record<string, RunResumeState>;
		} catch {
			return {} as Record<string, RunResumeState>;
		}
	}

	function getRunResumeState(targetThreadId: string) {
		return readRunResumeStateMap()[targetThreadId] ?? null;
	}

	function setRunResumeState(targetThreadId: string, state: RunResumeState) {
		if (typeof sessionStorage === 'undefined') {
			return;
		}

		const nextState = {
			...readRunResumeStateMap(),
			[targetThreadId]: state
		};
		sessionStorage.setItem(RUN_RESUME_STORAGE_KEY, JSON.stringify(nextState));
	}

	function clearRunResumeState(targetThreadId: string) {
		if (typeof sessionStorage === 'undefined') {
			return;
		}

		const nextState = Object.fromEntries(
			Object.entries(readRunResumeStateMap()).filter(([candidateThreadId]) => candidateThreadId !== targetThreadId)
		) as Record<string, RunResumeState>;
		sessionStorage.setItem(RUN_RESUME_STORAGE_KEY, JSON.stringify(nextState));
	}

	function parseAgentStreamBlock(block: string) {
		const lines = block.split('\n');
		const data = lines
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n');
		const id = lines
			.filter((line) => line.startsWith('id:'))
			.map((line) => line.slice(3).trimStart())
			.at(-1);

		if (!data) {
			return null;
		}

		return {
			id: id ?? null,
			event: JSON.parse(data) as AgentPromptStreamEvent
		};
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

	function upsertReasoningPart(
		messageId: string,
		updater: (part: ReasoningPart | null) => ReasoningPart
	) {
		updateAssistantMessage(messageId, (message) => {
			const parts = [...message.parts];
			const index = [...parts]
				.reverse()
				.findIndex((part) => part.type === 'reasoning' && part.status === 'running');
			const resolvedIndex = index === -1 ? -1 : parts.length - 1 - index;

			if (resolvedIndex === -1) {
				return {
					...message,
					parts: [...parts, updater(null)]
				};
			}

			const currentPart = parts[resolvedIndex];

			if (currentPart?.type !== 'reasoning') {
				return message;
			}

			parts[resolvedIndex] = updater(currentPart);

			return {
				...message,
				parts
			};
		});
	}

	function syncFinalReasoningParts(
		messageId: string,
		reasoningParts: readonly AgentReasoningContentPart[]
	) {
		if (reasoningParts.length === 0) {
			return;
		}

		updateAssistantMessage(messageId, (message) => {
			const nextParts = [...message.parts];
			const existingReasoningIndexes = nextParts.flatMap((part, index) =>
				part.type === 'reasoning' ? [index] : []
			);

			reasoningParts.forEach((reasoningPart, index) => {
				const existingIndex = existingReasoningIndexes[index];
				const existingPart =
					existingIndex !== undefined ? nextParts[existingIndex] : undefined;
				const nextReasoningPart: ReasoningPart = {
					id: existingPart?.type === 'reasoning' ? existingPart.id : createId(),
					type: 'reasoning',
					content: reasoningPart.thinking,
					status: 'done',
					...(reasoningPart.thinkingSignature
						? { thinkingSignature: reasoningPart.thinkingSignature }
						: {}),
					...(reasoningPart.redacted !== undefined ? { redacted: reasoningPart.redacted } : {})
				};

				if (existingIndex !== undefined) {
					nextParts[existingIndex] = nextReasoningPart;
					return;
				}

				const firstTextIndex = nextParts.findIndex((part) => part.type === 'text');

				if (firstTextIndex === -1) {
					nextParts.push(nextReasoningPart);
				} else {
					nextParts.splice(firstTextIndex, 0, nextReasoningPart);
				}
			});

			return {
				...message,
				parts: nextParts
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

	function toggleReasoning(reasoningId: string) {
		reasoningExpanded = {
			...reasoningExpanded,
			[reasoningId]: !reasoningExpanded[reasoningId]
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

	async function copyChatMessage(message: ChatMessage) {
		const content = formatChatMessageForCopy(message).replace(/^[A-Za-z]+:\n/u, '').trim();

		if (!content) {
			setMessageCopyStatus(message.id, 'error');
			return;
		}

		try {
			await navigator.clipboard.writeText(content);
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
					provider: streamEvent.model.provider,
					generationStartedAt: stats.generationStartedAt ?? streamEvent.timestamp
				}));
				return;
			case 'assistant_text_delta':
				if (streamEvent.usage) {
					updateAssistantStats(assistantId, (stats) => ({
						...stats,
						generationStartedAt: stats.generationStartedAt ?? streamEvent.timestamp,
						liveUsage: cloneUsage(streamEvent.usage)
					}));
				} else {
					updateAssistantStats(assistantId, (stats) => ({
						...stats,
						generationStartedAt: stats.generationStartedAt ?? streamEvent.timestamp
					}));
				}

				appendAssistantText(assistantId, streamEvent.delta);
				return;
			case 'reasoning_start':
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					generationStartedAt: stats.generationStartedAt ?? streamEvent.timestamp
				}));
				upsertReasoningPart(assistantId, (part) => ({
					id: part?.id ?? createId(),
					type: 'reasoning',
					content: part?.content ?? '',
					status: 'running',
					...(part?.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
					...(part?.redacted !== undefined ? { redacted: part.redacted } : {})
				}));
				return;
			case 'reasoning_delta':
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					generationStartedAt: stats.generationStartedAt ?? streamEvent.timestamp
				}));
				upsertReasoningPart(assistantId, (part) => ({
					id: part?.id ?? createId(),
					type: 'reasoning',
					content: `${part?.content ?? ''}${streamEvent.delta}`,
					status: 'running',
					...(part?.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
					...(part?.redacted !== undefined ? { redacted: part.redacted } : {})
				}));
				return;
			case 'reasoning_end':
				upsertReasoningPart(assistantId, (part) => ({
					id: part?.id ?? createId(),
					type: 'reasoning',
					content: part?.content ?? '',
					status: 'done',
					...(part?.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
					...(part?.redacted !== undefined ? { redacted: part.redacted } : {})
				}));
				return;
			case 'assistant_message':
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					providerModelId: streamEvent.model,
					api: streamEvent.api,
					provider: streamEvent.provider,
					generationStartedAt: stats.generationStartedAt ?? streamEvent.timestamp,
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
				syncFinalReasoningParts(assistantId, streamEvent.reasoning);

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
			case 'run_metrics':
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					runMetrics: { ...streamEvent.metrics },
					billedCostUsd: streamEvent.metrics.priceUsd
				}));
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
			case 'run_error':
				updateAssistantMessage(assistantId, (message) => ({
					...message,
					pending: false,
					canceled: /stopped|canceled/i.test(streamEvent.message) ? true : message.canceled
				}));
				updateAssistantStats(assistantId, (stats) => ({
					...stats,
					liveUsage: null,
					completedAt: stats.completedAt ?? streamEvent.timestamp,
					activeToolCallCount: 0,
					activeToolCallStartedAt: null
				}));
				errorMessage = streamEvent.message;
				appendSystemMessage(streamEvent.message);
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

	async function consumeAgentStream(
		response: Response,
		assistantId: string,
		options?: {
			onEvent?: (data: { id: string | null; event: AgentPromptStreamEvent }) => void;
		}
	) {
		if (!response.body) {
			throw new Error('The agent stream did not return a readable body.');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let completed = false;
		let persistedMessageCount = 1;
		let lastEventId: string | null = null;

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';

			for (const block of blocks) {
				const parsed = parseAgentStreamBlock(block);

				if (parsed) {
					lastEventId = parsed.id ?? lastEventId;
					options?.onEvent?.(parsed);
					handleStreamEvent(assistantId, parsed.event);
					persistedMessageCount += getPersistedMessageDelta(parsed.event);
					completed =
						completed || parsed.event.type === 'done' || parsed.event.type === 'run_error';
				}
			}
		}

		buffer += decoder.decode();

		for (const block of buffer.split('\n\n')) {
			const parsed = parseAgentStreamBlock(block);

			if (parsed) {
				lastEventId = parsed.id ?? lastEventId;
				options?.onEvent?.(parsed);
				handleStreamEvent(assistantId, parsed.event);
				persistedMessageCount += getPersistedMessageDelta(parsed.event);
				completed =
					completed || parsed.event.type === 'done' || parsed.event.type === 'run_error';
			}
		}

		return {
			completed,
			persistedMessageCount,
			lastEventId
		};
	}

	async function consumeAgentRunStream({
		streamPath,
		assistantId,
		controller,
		after,
		onEvent
	}: {
		streamPath: string;
		assistantId: string;
		controller: AbortController;
		after?: string | null;
		onEvent?: (data: { id: string | null; event: AgentPromptStreamEvent }) => void;
	}) {
		const streamUrl = new URL(streamPath, window.location.origin);

		if (after) {
			streamUrl.searchParams.set('after', after);
		}

		const response = await fetch(streamUrl, {
			method: 'GET',
			headers: {
				accept: 'text/event-stream'
			},
			signal: controller.signal
		});

		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			throw new Error(payload?.message ?? 'The agent stream request failed.');
		}

		return consumeAgentStream(response, assistantId, { onEvent });
	}

	async function getActiveRun(threadId: string) {
		const url = new URL(resolve('/api/agent/runs/active'), window.location.origin);
		url.searchParams.set('threadId', threadId);
		const response = await fetch(url);

		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			throw new Error(payload?.message ?? 'Failed to load the active chat run.');
		}

		return (await response.json()) as ActiveAgentRunResponse | null;
	}

	async function killActiveRun(runId: string) {
		const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}`, {
			method: 'DELETE'
		});

		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? 'Failed to stop the active chat run.');
		}
	}

	async function submitPrompt(
		promptOverride = draft,
		options?: { clearDraft?: boolean; attachmentIds?: AttachmentId[] }
	) {
		const prompt = promptOverride.trim();
		const clearDraft = options?.clearDraft ?? true;
		const currentModelId = selectedModelId ?? resolvedSelectedModelId;
		const selectedAttachmentIds =
			options?.attachmentIds ??
			composerPendingAttachments.map((attachment) => attachment.id as AttachmentId);
		const selectedAttachments = attachments.filter((attachment) =>
			selectedAttachmentIds.includes(attachment.id as AttachmentId)
		);

		if (
			!prompt ||
			isSendInFlight ||
			!currentModelId ||
			!isModelSelectionReady ||
			isAttachmentWorkPending
		) {
			return;
		}

		isSubmittingPrompt = true;

		try {
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
			const previousAttachmentState = cloneThreadAttachments(selectedAttachments);

			attachments = attachments.map((attachment) =>
				selectedAttachmentIds.includes(attachment.id as AttachmentId)
					? {
							...attachment,
							status: 'attached',
							messageSequence: nextUserSequence,
							updatedAt: Date.now()
						}
					: attachment
			);

			messages = [
				...messages,
				{
					id: userMessageId,
					role: 'user',
					content: prompt,
					attachments: cloneThreadAttachments(
						attachments.filter((attachment) => attachment.messageSequence === nextUserSequence)
					),
					createdAt: Date.now(),
					persistedSequence: nextUserSequence
				},
				{
					id: assistantId,
					role: 'assistant',
					parts: [],
					createdAt: Date.now(),
					pending: true,
					canceled: false,
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
			} else {
				await tick();
				scrollContainer?.scrollTo({ top: 0, behavior: 'instant' });
			}

			try {
				const response = await fetch(resolvedAgentApiPath, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						threadId: activeThreadId,
						prompt,
						modelId: currentModelId,
						attachmentIds: selectedAttachmentIds
					}),
					signal: controller.signal
				});

				if (!response.ok) {
					const payload = (await response.json().catch(() => null)) as {
						message?: string;
					} | null;
					throw new Error(payload?.message ?? 'The agent stream request failed.');
				}

				const payload = (await response.json()) as AgentRunStartResponse;
				setRunResumeState(activeThreadId, {
					runId: payload.runId,
					lastEventId: null
				});
				const streamResult = await consumeAgentRunStream({
					streamPath: payload.streamPath,
					assistantId,
					controller,
					onEvent: ({ id }) => {
						setRunResumeState(activeThreadId, {
							runId: payload.runId,
							lastEventId: id
						});
					}
				});

				if (streamResult.completed) {
					setThreadPersistedMessageCount(
						activeThreadId,
						nextUserSequence + streamResult.persistedMessageCount
					);
					clearRunResumeState(activeThreadId);
				}
			} catch (error) {
				if (controller.signal.aborted) {
					attachments = attachments.map((attachment) => {
						const previous = previousAttachmentState.find((candidate) => candidate.id === attachment.id);
						return previous ? previous : attachment;
					});
					updateAssistantMessage(assistantId, (message) => ({
						...message,
						pending: false
					}));
					return;
				}

				const message = getHumanErrorMessage(error, 'The chat request failed.');
				errorMessage = message;
				attachments = attachments.map((attachment) => {
					const previous = previousAttachmentState.find((candidate) => candidate.id === attachment.id);
					return previous ? previous : attachment;
				});
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
		} finally {
			isSubmittingPrompt = false;
		}
	}

	async function resumeActiveRun(targetThreadId: string) {
		if (isStreaming || resumingThreadId === targetThreadId) {
			return;
		}

		resumingThreadId = targetThreadId;
		let controller: AbortController | null = null;
		let assistantId: string | null = null;

		try {
			const activeRun = await getActiveRun(targetThreadId);

			if (!activeRun || threadId !== targetThreadId || isStreaming) {
				return;
			}

			const nextUserSequence = getThreadPersistedMessageCount(targetThreadId);
			const existingPendingAssistant = [...messages]
				.reverse()
				.find(
					(message): message is AssistantMessage => message.role === 'assistant' && message.pending
				);
			const resumeState = getRunResumeState(targetThreadId);
			const resumeAfter =
				existingPendingAssistant && resumeState?.runId === activeRun.runId
					? resumeState.lastEventId
					: null;

			assistantId = existingPendingAssistant?.id ?? createId();

			if (!existingPendingAssistant) {
				const selectedAttachments = attachments.filter((attachment) =>
					activeRun.attachmentIds.includes(attachment.id)
				);
				const userMessageId = createId();

				messages = [
					...messages,
					{
						id: userMessageId,
						role: 'user',
						content: activeRun.prompt,
						attachments: cloneThreadAttachments(selectedAttachments),
						createdAt: Date.now(),
						persistedSequence: nextUserSequence
					},
					{
						id: assistantId,
						role: 'assistant',
						parts: [],
						createdAt: Date.now(),
						pending: true,
						canceled: false,
						stats: createAssistantStats(selectedModel)
					}
				];
			}

			isStreaming = true;
			controller = new AbortController();
			currentRequest = controller;
			const streamResult = await consumeAgentRunStream({
				streamPath: activeRun.streamPath,
				assistantId,
				controller,
				after: resumeAfter,
				onEvent: ({ id }) => {
					setRunResumeState(targetThreadId, {
						runId: activeRun.runId,
						lastEventId: id
					});
				}
			});

			if (streamResult.completed) {
				setThreadPersistedMessageCount(
					targetThreadId,
					nextUserSequence + streamResult.persistedMessageCount
				);
				clearRunResumeState(targetThreadId);
			}
		} catch (error) {
			if (controller?.signal.aborted) {
				return;
			}

			const message = getHumanErrorMessage(error, 'The chat request failed.');
			errorMessage = message;
			if (assistantId) {
				updateAssistantMessage(assistantId, (current) => ({ ...current, pending: false }));
			}
			appendSystemMessage(message);
		} finally {
			if (currentRequest === controller) {
				currentRequest = null;
			}

			if (threadId === targetThreadId) {
				isStreaming = false;
			}

			if (resumingThreadId === targetThreadId) {
				resumingThreadId = null;
			}
		}
	}

	async function stopStreaming() {
		const activeThreadId = threadId;

		currentRequest?.abort();
		currentRequest = null;
		isStreaming = false;

		if (!activeThreadId) {
			return;
		}

		try {
			const resumeState = getRunResumeState(activeThreadId);
			const activeRun = resumeState ? { runId: resumeState.runId } : await getActiveRun(activeThreadId);
			const runId = activeRun?.runId;

			if (!runId) {
				return;
			}

			await killActiveRun(runId);
			clearRunResumeState(activeThreadId);
			messages = messages.map((message) =>
				message.role === 'assistant' && message.pending
					? { ...message, pending: false, canceled: true }
					: message
			);
		} catch (error) {
			const message = getHumanErrorMessage(error, 'Failed to stop the active run.');
			errorMessage = message;
			appendSystemMessage(message);
		}
	}

	function openEditPromptModal(message: UserMessage) {
		if (
			isSendInFlight ||
			retryingMessageId !== null ||
			editingMessageId !== null ||
			message.persistedSequence === null
		) {
			return;
		}

		editPromptState = {
			messageId: message.id,
			persistedSequence: message.persistedSequence,
			attachmentIds: message.attachments.map((attachment) => attachment.id as AttachmentId)
		};
		editPromptDraft = message.content;
		editPromptError = null;
		editingMessageId = message.id;
		void tick().then(() => {
			editPromptComposer?.focus();
			const end = editPromptDraft.length;
			editPromptComposer?.setSelectionRange(end, end);
		});
	}

	async function rewindAndResubmitUserMessage({
		message,
		prompt,
		attachmentIds
	}: {
		message: UserMessage;
		prompt: string;
		attachmentIds: AttachmentId[];
	}) {
		if (
			isSendInFlight ||
			retryingMessageId !== null ||
			!convex ||
			!threadId ||
			message.persistedSequence === null
		) {
			return false;
		}

		const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);

		if (messageIndex === -1) {
			return false;
		}

		const trimmedPrompt = prompt.trim();

		if (!trimmedPrompt) {
			throw new Error('Prompt cannot be empty.');
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
			await submitPrompt(trimmedPrompt, {
				clearDraft: false,
				attachmentIds
			});
			return true;
		} finally {
			retryingMessageId = null;
		}
	}

	function handleEditPromptKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeEditPromptModal();
			return;
		}

		if (event.key !== 'Enter' || event.shiftKey) {
			return;
		}

		event.preventDefault();
		void submitEditedPrompt();
	}

	async function submitEditedPrompt() {
		if (!editPromptState) {
			return;
		}

		const currentEditState = editPromptState;
		const prompt = editPromptDraft;
		const targetMessage = messages.find(
			(candidate): candidate is UserMessage =>
				candidate.role === 'user' && candidate.id === currentEditState.messageId
		);

		if (!targetMessage) {
			closeEditPromptModal();
			return;
		}

		closeEditPromptModal();

		try {
			await rewindAndResubmitUserMessage({
				message: targetMessage,
				prompt,
				attachmentIds: currentEditState.attachmentIds
			});
		} catch (error) {
			const message = getHumanErrorMessage(error, 'Failed to edit the selected prompt.');
			errorMessage = message;
			appendSystemMessage(message);
		}
	}

	function clearConversationUiState() {
		errorMessage = null;
		toolExpanded = {};
		toolGroupExpanded = {};
		reasoningExpanded = {};
		messageCopyState = {};
		fullThreadCopyState = 'idle';
	}

	async function retryUserMessage(message: UserMessage) {
		try {
			await rewindAndResubmitUserMessage({
				message,
				prompt: message.content,
				attachmentIds: message.attachments.map((attachment) => attachment.id as AttachmentId)
			});
		} catch (error) {
			const retryError = getHumanErrorMessage(
				error,
				'Failed to retry the selected prompt.'
			);
			errorMessage = retryError;
			appendSystemMessage(retryError);
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

	async function insertMention(name: string) {
		if (!mentionState || !composer || !name) {
			return;
		}

		const mention = `@${name}`;
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
				void insertMention(resourceMentionSuggestions[mentionMenuIndex]?.name ?? '');
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

	async function selectModel(id: AgentModelId) {
		if (!convex || isComposerDisabled) {
			return;
		}

		const previousSelectedModelId = selectedModelId;
		const previousPendingDefaultModelId = pendingDefaultModelId;
		const previousPendingThreadModelIds = pendingThreadModelIds;

		selectedModelId = id;
		modelPickerOpen = false;

		try {
			if (threadId) {
				pendingThreadModelIds = {
					...pendingThreadModelIds,
					[threadId]: id
				};
				pendingDefaultModelId = id;
				await convex.mutation(api.authed.agentThreads.setThreadModelSelection, {
					threadId,
					modelId: id
				});
				return;
			}

			pendingDefaultModelId = id;
			await convex.mutation(api.authed.agentThreads.setDefaultModel, {
				modelId: id
			});
		} catch (error) {
			selectedModelId = previousSelectedModelId;
			pendingDefaultModelId = previousPendingDefaultModelId;
			pendingThreadModelIds = previousPendingThreadModelIds;
			const message = getHumanErrorMessage(error, 'Failed to update the selected model.');
			errorMessage = message;
			appendSystemMessage(message);
		}
	}

	function handleModelPickerKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			modelPickerOpen = false;
		}
	}

	const composerAutofocusKeyPattern = /^[a-z0-9]$/i;

	function isTextEntryTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) {
			return false;
		}

		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement ||
			target.isContentEditable
		) {
			return true;
		}

		return target.closest('input, textarea, select, [contenteditable], [role="textbox"]') !== null;
	}

	async function focusComposerWithTypedKey(key: string) {
		if (!composer || composer.disabled) {
			return;
		}

		const selectionStart = composer.selectionStart ?? draft.length;
		const selectionEnd = composer.selectionEnd ?? selectionStart;
		const nextDraft = `${draft.slice(0, selectionStart)}${key}${draft.slice(selectionEnd)}`;
		const nextCaretPosition = selectionStart + key.length;

		draft = nextDraft;
		await tick();

		if (!composer || composer.disabled) {
			return;
		}

		composer.focus();
		composer.setSelectionRange(nextCaretPosition, nextCaretPosition);
		updateMentionState();
	}

	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}

		if (event.key === 'Escape' && spotlightAttachment !== null) {
			closeAttachmentSpotlight();
			return;
		}

		if (editPromptState !== null || spotlightAttachment !== null || modelPickerOpen) {
			return;
		}

		if (!composerAutofocusKeyPattern.test(event.key)) {
			return;
		}

		if (isTextEntryTarget(event.target) || isTextEntryTarget(document.activeElement)) {
			return;
		}

		if (!composer || composer.disabled) {
			return;
		}

		event.preventDefault();
		void focusComposerWithTypedKey(event.key);
	}

	function handleGlobalPaste(event: ClipboardEvent) {
		if (isComposerDisabled) {
			return;
		}

		const pastedFiles = fileListFromClipboard(event.clipboardData).filter(isImageFile);

		if (pastedFiles.length === 0) {
			return;
		}

		event.preventDefault();
		void uploadAttachments(pastedFiles);
	}

	function resetChatDropState() {
		dragDepth = 0;
		isChatDropActive = false;
	}

	function handleChatDragEnter(event: DragEvent) {
		if (isComposerDisabled) {
			return;
		}

		if (!event.dataTransfer?.types.includes('Files')) {
			return;
		}

		event.preventDefault();
		dragDepth += 1;
		isChatDropActive = true;
	}

	function handleChatDragOver(event: DragEvent) {
		if (isComposerDisabled) {
			return;
		}

		if (!event.dataTransfer?.types.includes('Files')) {
			return;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
		isChatDropActive = true;
	}

	function handleChatDragLeave(event: DragEvent) {
		if (!event.dataTransfer?.types.includes('Files')) {
			return;
		}

		event.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);

		if (dragDepth === 0) {
			isChatDropActive = false;
		}
	}

	function handleChatDrop(event: DragEvent) {
		if (!event.dataTransfer?.types.includes('Files')) {
			return;
		}

		event.preventDefault();
		const droppedFiles = fileListFromDataTransfer(event.dataTransfer);
		resetChatDropState();

		if (droppedFiles.length === 0) {
			return;
		}

		void uploadAttachments(droppedFiles);
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} onpaste={handleGlobalPaste} />

<div
	class="flex min-h-0 flex-1 flex-col"
	role="region"
	aria-label="Chat attachment dropzone"
	ondragenter={handleChatDragEnter}
	ondragover={handleChatDragOver}
	ondragleave={handleChatDragLeave}
	ondrop={handleChatDrop}
>
	<div class="relative min-h-0 flex-1">
		{#if editPromptState}
			<div class="absolute inset-0 z-[75] flex items-center justify-center p-4" role="presentation">
				<button
					type="button"
					class="absolute inset-0 bg-[hsl(var(--bc-bg))]/82 backdrop-blur-sm"
					onclick={closeEditPromptModal}
					aria-label="Close edit prompt dialog"
				></button>
				<div
					class="bc-card relative flex w-full max-w-2xl flex-col gap-4 p-5 shadow-[0_24px_80px_hsl(var(--bc-shadow)/0.5)]"
					role="dialog"
					aria-modal="true"
					aria-label="Edit prompt"
					tabindex="-1"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="space-y-1">
							<h2 class="text-base font-semibold text-[hsl(var(--bc-fg))]">Edit prompt</h2>
							<p class="bc-muted text-sm">
								Sending this will replace the selected message and rerun everything after it.
							</p>
						</div>
						<button
							type="button"
							class="chat-message-action"
							onclick={closeEditPromptModal}
							aria-label="Close edit prompt dialog"
						>
							Cancel
						</button>
					</div>

					<textarea
						bind:this={editPromptComposer}
						bind:value={editPromptDraft}
						class="bc-scrollbar min-h-44 w-full resize-y border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface-2))] px-4 py-3 text-sm leading-6 text-[hsl(var(--bc-fg))] placeholder:text-[hsl(var(--bc-fg-muted))] focus:border-[hsl(var(--bc-accent))] focus:outline-none"
						placeholder="Rewrite the prompt..."
						onkeydown={handleEditPromptKeydown}
					></textarea>

					<div class="flex items-center justify-between gap-3">
						<div class="space-y-1">
							{#if editPromptError}
								<p class="text-sm text-[hsl(var(--bc-error))]">{editPromptError}</p>
							{:else}
								<p class="bc-muted text-xs">
									Press Enter to send. Use Shift+Enter for a new line.
								</p>
							{/if}
						</div>
						<div class="flex items-center gap-3">
							<span class="bc-muted text-xs tabular-nums">
								{formatTokenCount(editDraftTokenCount)} {editDraftTokenCount === 1 ? 'token' : 'tokens'}
							</span>
							<button
								type="button"
								class="bc-btn"
								onclick={() => void submitEditedPrompt()}
								disabled={!editPromptDraft.trim() || retryingMessageId === editPromptState.messageId}
							>
								{retryingMessageId === editPromptState.messageId ? 'Sending...' : 'Send'}
							</button>
						</div>
					</div>
				</div>
			</div>
		{/if}

		{#if spotlightAttachment}
			<div
				class="absolute inset-0 z-[70] flex items-center justify-center overflow-hidden bg-black/80 p-4 backdrop-blur-sm sm:p-6"
				role="dialog"
				tabindex="-1"
				aria-modal="true"
				aria-label={`Viewing ${spotlightAttachment.fileName}`}
			>
				<button
					type="button"
					class="absolute inset-0 cursor-zoom-out"
					onclick={closeAttachmentSpotlight}
					aria-label={`Close image view for ${spotlightAttachment.fileName}`}
				></button>

				<div class="relative z-10 flex max-h-full w-full max-w-5xl items-center justify-center">
					<button
						type="button"
						class="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-lg text-white transition hover:bg-black/85"
						onclick={closeAttachmentSpotlight}
						aria-label={`Close image view for ${spotlightAttachment.fileName}`}
					>
						×
					</button>

					<img
						src={spotlightAttachment.previewUrl}
						alt={spotlightAttachment.fileName}
						class="block max-h-full max-w-full rounded-xl border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] object-contain shadow-[0_24px_80px_hsl(var(--bc-shadow)/0.5)]"
					/>
				</div>
			</div>
		{/if}

		{#if isChatDropActive}
			<div class="pointer-events-none absolute inset-0 z-10 rounded-[28px] border-2 border-dashed border-[hsl(var(--bc-success))] bg-[hsl(var(--bc-success)/0.08)] p-6">
				<div class="flex h-full items-center justify-center rounded-[22px] bg-[hsl(var(--bc-bg))]/80 text-center backdrop-blur-sm">
					<div class="space-y-2">
						<p class="text-sm font-medium text-[hsl(var(--bc-success))]">
							Drop images anywhere to attach them
						</p>
						<p class="bc-muted text-xs">PNG, JPG, GIF, WebP, HEIC, and other image types</p>
					</div>
				</div>
			</div>
		{/if}

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
							{#if message.attachments.length > 0}
								<div class="mb-3 flex flex-wrap gap-3">
									{#each message.attachments as attachment (attachment.id)}
										<div class="overflow-hidden rounded-2xl border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg-soft))]">
											<button
												type="button"
												class="block"
												onclick={() => openAttachmentSpotlight(attachment)}
												aria-label={`View ${attachment.fileName}`}
											>
												<img
													src={attachment.previewUrl}
													alt={attachment.fileName}
													class="h-28 w-28 object-cover"
												/>
											</button>
										</div>
									{/each}
								</div>
							{/if}
							<p class="text-sm leading-6 whitespace-pre-wrap">{message.content}</p>
							<div class="chat-message-actions">
								<button
									type="button"
									class="chat-message-action"
									onclick={() => openEditPromptModal(message)}
									disabled={isSendInFlight ||
										retryingMessageId !== null ||
										editingMessageId !== null ||
										message.persistedSequence === null}
								>
									{editingMessageId === message.id ? 'Editing...' : 'Edit'}
								</button>
								<button
									type="button"
									class="chat-message-action"
									onclick={() => void copyChatMessage(message)}
								>
									{messageCopyState[message.id] === 'copied'
										? 'Copied'
										: messageCopyState[message.id] === 'error'
											? 'Copy failed'
											: 'Copy'}
								</button>
								<button
									type="button"
									class="chat-message-action"
									onclick={() => void retryUserMessage(message)}
									disabled={isSendInFlight ||
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
								{#if message.canceled}
									<div class="assistant-meta-chip">Canceled</div>
								{/if}
							</div>

							<div class="assistant-sections">
								{#each groupMessageParts(message.parts) as segment (segment.type === 'text' || segment.type === 'reasoning' ? segment.part.id : getToolGroupKey(segment.tools))}
									{#if segment.type === 'text'}
										<div class="assistant-section assistant-section-text">
											<MarkdownMessage content={segment.part.content} />
										</div>
									{:else if segment.type === 'reasoning'}
										<div class="assistant-section tool-group">
										<button
											type="button"
											class="tool-group-bar"
											onclick={() => toggleReasoning(segment.part.id)}
										>
											<div class="tool-group-bar-left">
												<span
													class={`tool-dot ${segment.part.status === 'running' ? 'tool-dot-pending' : 'tool-dot-completed'}`}
												></span>
												<span class="tool-group-bar-label">
													{getReasoningLabel(segment.part)}
												</span>
											</div>
											<div class="tool-group-bar-right">
											<svg
												class:rotate-180={reasoningExpanded[segment.part.id]}
												class="tool-group-chevron"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.25"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="m6 9 6 6 6-6" />
											</svg>
											</div>
										</button>

										{#if reasoningExpanded[segment.part.id]}
											<div
												class="tool-group-panel"
												transition:slide={{ duration: 150 }}
											>
												<p class="text-sm leading-6 whitespace-pre-wrap text-[hsl(var(--bc-fg-muted))]">
													{segment.part.content || 'Waiting for reasoning summary...'}
												</p>
											</div>
										{/if}
									</div>
									{:else}
										{@const groupKey = getToolGroupKey(segment.tools)}
										{@const groupStatus = getToolGroupStatus(segment.tools)}
										<div class={`assistant-section tool-group ${getToolGroupTypeClass(segment.tools)}`}>
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
							</div>

							{#if message.parts.length === 0 && message.pending}
								<p class="bc-muted text-sm">Waiting for the first tokens...</p>
							{/if}

							{#if getAssistantUsage(message)}
								{@const usage = getAssistantUsage(message)}
								{@const billedCostUsd = getAssistantBilledCostUsd(message)}
								{@const totalToolCalls = getAssistantTotalToolCalls(message)}
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
										{#if totalToolCalls !== null}
											<div class="assistant-stat">{formatTokenCount(totalToolCalls)} tools</div>
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
		{#if composerAttachments.length > 0}
			<div class="mb-3 flex flex-wrap gap-3 px-1 py-1">
				{#each composerAttachments as attachment (attachment.id)}
					<div class="relative h-24 w-24 overflow-hidden rounded-lg border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface-2))]">
						<button
							type="button"
							class="block h-full w-full text-left"
							onclick={() => openAttachmentSpotlight(attachment)}
							aria-label={`View ${attachment.fileName}`}
						>
							{#if attachment.previewUrl && !attachmentPreviewErrors.includes(attachment.id)}
								<img
									src={attachment.previewUrl}
									alt={attachment.fileName}
									class="h-full w-full object-cover"
									draggable="false"
									loading="lazy"
									onload={() => clearAttachmentPreviewError(attachment.id)}
									onerror={() => markAttachmentPreviewError(attachment.id)}
								/>
							{:else}
								<div class="flex h-full w-full items-end bg-[hsl(var(--bc-surface))] p-2 text-xs font-medium tracking-[0.14em] text-[hsl(var(--bc-fg-muted))]">
									{getAttachmentExtension(attachment)}
								</div>
							{/if}
						</button>

						<button
							type="button"
							class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-sm text-white transition hover:bg-black/80 disabled:cursor-default disabled:opacity-45"
							onclick={() => void removeAttachment(attachment)}
							disabled={attachment.status !== 'pending'}
							aria-label={`Remove ${attachment.fileName}`}
						>
							×
						</button>

						{#if attachment.status === 'uploading' || attachment.status === 'removing'}
							<div class="absolute inset-x-0 bottom-0 bg-black/72 px-2 py-1.5 text-[10px] text-white">
								<div class="mb-1 flex items-center justify-between gap-2">
									<span>{getAttachmentStatusLabel(attachment)}...</span>
								</div>
								<div class="h-1.5 overflow-hidden rounded-full bg-white/20">
									<div
										class="h-full w-1/2 rounded-full bg-white/75 animate-pulse"
									></div>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<div class={`input-wrapper ${isCurrentThreadRunning ? 'input-wrapper-running' : ''}`}>
			{#if mentionState !== null}
				<div class="absolute inset-x-0 bottom-full z-40 mb-3">
					<div
						class="overflow-hidden rounded-3xl border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] shadow-[0_-12px_40px_hsl(var(--bc-shadow)/0.35)]"
					>
						{#if resourceMentionSuggestions.length > 0}
							<div
								class="border-b border-[hsl(var(--bc-border))] px-4 py-3 text-sm font-medium text-[hsl(var(--bc-fg-muted))]"
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
										onclick={() => void insertMention(resource.name)}
									>
										<div class="flex items-start justify-between gap-3">
											<div class="space-y-1">
												<div class="flex flex-wrap items-center gap-2">
													<span class="font-medium">{resource.name}</span>
													<span class="text-xs text-[hsl(var(--bc-fg-muted))]">@{resource.name}</span>
												</div>
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

			<input
				bind:this={attachmentPicker}
				type="file"
				class="hidden"
				accept="image/*"
				multiple
				onchange={(event) => void uploadAttachments((event.currentTarget as HTMLInputElement).files)}
			/>

			<textarea
				bind:this={composer}
				bind:value={draft}
				class="chat-input bc-scrollbar"
				rows="1"
				placeholder="Ask the agent to inspect code, run a command, or read a file..."
				disabled={isComposerDisabled}
				oninput={handleComposerInput}
				onclick={handleComposerClick}
				onkeydown={handleComposerKeydown}
				onkeyup={handleComposerKeyup}
			></textarea>

			<button
				type="button"
				class="input-attachment-btn"
				disabled={isComposerDisabled}
				onclick={openAttachmentPicker}
			>
				Add image
			</button>

			{#if isStreaming}
				<button
					type="button"
					class="send-btn"
					onclick={() => void stopStreaming()}
					aria-label="Stop streaming"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
						<rect x="6" y="6" width="12" height="12" rx="2" />
					</svg>
				</button>
			{:else if isSubmitPending}
				<button
					type="button"
					class="send-btn"
					disabled={true}
					aria-label="Sending message"
				>
					<svg
						class="animate-spin"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M21 12a9 9 0 1 1-6.219-8.56" />
					</svg>
				</button>
			{:else}
				<button
					type="button"
					class="send-btn"
					onclick={() => void submitPrompt()}
					disabled={!canSubmitPrompt}
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
					disabled={isComposerDisabled}
					onclick={() => (modelPickerOpen = !modelPickerOpen)}
				>
					<span>{isModelSelectionReady ? selectedModel.label : 'Loading model...'}</span>
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
								disabled={isComposerDisabled}
								onclick={() => void selectModel(option.id)}
							>
								<span class="model-picker-option-label">{option.label}</span>
								<span class="model-picker-option-desc">{option.description}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<div class="input-footer-meta">
				{#if isSubmitPending}
					<span class="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[hsl(var(--bc-warning))]">
						<span class="h-1.5 w-1.5 rounded-full bg-current animate-pulse"></span>
						Sending
					</span>
				{/if}

				{#if taggedThreadResources.length > 0}
					<div class="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-[hsl(var(--bc-fg-muted))]">
						<span class="shrink-0 uppercase tracking-[0.18em]">Tagged</span>
						<div class="flex min-w-0 flex-wrap gap-1.5">
							{#each taggedThreadResources as resource (resource.name)}
								{#if resource.id}
									<a
										href={resolve(`/app/resources/${resource.id}`)}
										class="inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--bc-border))/0.75] bg-[hsl(var(--bc-surface))]/65 px-2 py-1 leading-none text-[11px] text-[hsl(var(--bc-fg-muted))] transition hover:border-[hsl(var(--bc-success))/0.3] hover:text-[hsl(var(--bc-fg))]"
									>
										<span class="font-medium text-[hsl(var(--bc-fg))]">@{resource.name}</span>
										{#if resource.itemCount !== null}
											<span>{resource.itemCount}</span>
										{/if}
									</a>
								{:else}
									<div
										class="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[hsl(var(--bc-border))/0.75] bg-[hsl(var(--bc-surface))]/50 px-2 py-1 leading-none text-[11px] text-[hsl(var(--bc-fg-muted))]"
										title="This resource was tagged earlier in the thread but is no longer available."
									>
										<span class="font-medium">@{resource.name}</span>
										<span class="uppercase tracking-[0.14em]">missing</span>
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{/if}

				<span class="bc-muted tabular-nums whitespace-nowrap">
					{formatTokenCount(draftTokenCount)} {draftTokenCount === 1 ? 'token' : 'tokens'}
				</span>
			</div>
		</div>
	</div>
</div>

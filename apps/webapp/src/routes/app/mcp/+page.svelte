<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getHumanErrorMessage } from '$lib/errors';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import {
		isAssistantMessage,
		isToolResultMessage,
		isUserMessage,
		type AgentThreadListItem,
		type StoredAgentThreadMessage
	} from '$lib/types/agent';
	import { api } from '@btca/convex/api';
	import { useQuery } from 'convex-svelte';

	type TimelineItem = {
		id: string;
		role: 'user' | 'assistant' | 'tool';
		title: string;
		body: string;
		timestamp: number | null;
		isError?: boolean;
	};

	const authContext = getAuthContext();

	const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});

	const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	const mcpThreadsQuery = useQuery(
		api.authed.agentThreads.listMcp,
		() => (authContext.currentUser ? {} : 'skip'),
		() => ({ keepPreviousData: true })
	);

	const selectedThreadId = $derived(
		page.url.searchParams.get('thread') ?? mcpThreadsQuery.data?.[0]?.threadId ?? null
	);

	const threadQuery = useQuery(
		api.authed.agentThreads.get,
		() => (authContext.currentUser && selectedThreadId ? { threadId: selectedThreadId } : 'skip'),
		() => ({ keepPreviousData: true })
	);

	const selectedThread = $derived(threadQuery.data?.thread ?? null);

	const timelineItems = $derived(
		(threadQuery.data?.messages ?? []).map((message) => toTimelineItem(message))
	);

	function formatShortDate(timestamp: number) {
		return shortDateFormatter.format(timestamp);
	}

	function formatFullDate(timestamp: number | null) {
		return timestamp === null ? 'Unknown time' : fullDateFormatter.format(timestamp);
	}

	function getThreadLabel(thread: AgentThreadListItem) {
		return thread.title?.trim() || `MCP thread ${thread.threadId.slice(0, 8)}`;
	}

	function getStatusLabel(status: AgentThreadListItem['status']) {
		switch (status) {
			case 'running':
				return 'Running';
			case 'error':
				return 'Error';
			default:
				return 'Idle';
		}
	}

	function getStatusClasses(status: AgentThreadListItem['status']) {
		switch (status) {
			case 'running':
				return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
			case 'error':
				return 'border-rose-500/40 bg-rose-500/10 text-rose-200';
			default:
				return 'border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg-elevated))] text-[hsl(var(--bc-fg-muted))]';
		}
	}

	function getActivityLabel(thread: AgentThreadListItem) {
		if (thread.activity) {
			return thread.activity;
		}

		if (thread.status === 'running') {
			return 'Processing MCP request';
		}

		return 'No activity recorded yet.';
	}

	function getTextContent(content: unknown) {
		if (typeof content === 'string') {
			return content;
		}

		if (!Array.isArray(content)) {
			return '';
		}

		return content
			.flatMap((part) =>
				typeof part === 'object' &&
				part !== null &&
				part.type === 'text' &&
				typeof part.text === 'string'
					? [part.text]
					: []
			)
			.join('\n\n');
	}

	function toTimelineItem(message: StoredAgentThreadMessage): TimelineItem {
		try {
			const parsed = JSON.parse(message.rawJson);

			if (isUserMessage(parsed)) {
				return {
					id: `${message.sequence}-user`,
					role: 'user',
					title: 'User',
					body: getTextContent(parsed.content) || 'Empty user message',
					timestamp: parsed.timestamp
				};
			}

			if (isAssistantMessage(parsed)) {
				return {
					id: `${message.sequence}-assistant`,
					role: 'assistant',
					title: 'Assistant',
					body:
						getTextContent(parsed.content) || parsed.errorMessage || 'No assistant text available',
					timestamp: parsed.timestamp,
					isError: typeof parsed.errorMessage === 'string' && parsed.errorMessage.length > 0
				};
			}

			if (isToolResultMessage(parsed)) {
				return {
					id: `${message.sequence}-tool`,
					role: 'tool',
					title: `Tool · ${parsed.toolName}`,
					body: getTextContent(parsed.content) || 'Tool completed without text output',
					timestamp: parsed.timestamp,
					isError: parsed.isError
				};
			}
		} catch {
			// fall through to a plain fallback entry
		}

		return {
			id: `${message.sequence}-unknown`,
			role: 'tool',
			title: message.role,
			body: message.rawJson,
			timestamp: message.timestamp,
			isError: true
		};
	}

	function selectThread(threadId: string) {
		void goto(resolve(`/app/mcp?thread=${encodeURIComponent(threadId)}`), {
			noScroll: true,
			keepFocus: true
		});
	}

	function openInChat(threadId: string) {
		void goto(resolve(`/app/chat/${encodeURIComponent(threadId)}`), {
			noScroll: true,
			keepFocus: true
		});
	}
</script>

<svelte:head>
	<title>btca web | MCP</title>
</svelte:head>

<div class="flex min-h-0 flex-1 bg-[hsl(var(--bc-bg))]">
	<section
		class="flex w-[23rem] shrink-0 flex-col border-r border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))]"
	>
		<div class="border-b border-[hsl(var(--bc-border))] px-5 py-4">
			<div class="flex items-start justify-between gap-3">
				<div class="space-y-1">
					<p class="bc-kicker">
						<span class="bc-kickerDot"></span>
						MCP
					</p>
					<h1 class="bc-title text-2xl">Threads</h1>
				</div>
				<a href={resolve('/app/mcp/getting-started')} class="bc-btn shrink-0 text-xs"> Setup </a>
			</div>
		</div>

		<div class="bc-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
			{#if mcpThreadsQuery.isLoading}
				<div class="bc-card p-4 text-sm text-[hsl(var(--bc-fg-muted))]">Loading threads...</div>
			{:else if mcpThreadsQuery.error}
				<div class="bc-card border-[hsl(var(--bc-error))] p-4 text-sm text-[hsl(var(--bc-error))]">
					{getHumanErrorMessage(mcpThreadsQuery.error, 'Failed to load MCP threads.')}
				</div>
			{:else if (mcpThreadsQuery.data?.length ?? 0) === 0}
				<div class="bc-card border-dashed p-4 text-sm text-[hsl(var(--bc-fg-muted))]">
					No MCP threads yet.
				</div>
			{:else}
				{#each mcpThreadsQuery.data ?? [] as thread (thread.threadId)}
					<button
						type="button"
						class={[
							'bc-card w-full space-y-3 p-4 text-left transition hover:border-[hsl(var(--bc-accent))]',
							selectedThreadId === thread.threadId &&
								'border-[hsl(var(--bc-accent))] bg-[hsl(var(--bc-bg-elevated))]'
						]}
						onclick={() => selectThread(thread.threadId)}
					>
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="truncate text-sm font-semibold text-[hsl(var(--bc-fg))]">
									{getThreadLabel(thread)}
								</p>
								<p class="mt-1 text-xs text-[hsl(var(--bc-fg-muted))]">
									Updated {formatShortDate(thread.updatedAt)}
								</p>
							</div>
							<span
								class={[
									'inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[10px] font-semibold tracking-[0.14em] uppercase',
									getStatusClasses(thread.status)
								]}
							>
								{getStatusLabel(thread.status)}
							</span>
						</div>

						<p class="line-clamp-3 text-sm leading-6 text-[hsl(var(--bc-fg-muted))]">
							{getActivityLabel(thread)}
						</p>

						<div
							class="flex items-center justify-between text-[11px] text-[hsl(var(--bc-fg-muted))]"
						>
							<span>{thread.messageCount} messages</span>
							<span
								>{thread.sandboxId
									? `Sandbox ${thread.sandboxId.slice(0, 8)}`
									: 'Sandbox pending'}</span
							>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	</section>

	<section class="flex min-w-0 flex-1 flex-col">
		{#if selectedThread === null}
			<div class="flex min-h-0 flex-1 items-center justify-center p-8">
				<p class="bc-muted text-sm">Select a thread to view.</p>
			</div>
		{:else}
			<div class="border-b border-[hsl(var(--bc-border))] px-6 py-5">
				<div class="flex flex-wrap items-start justify-between gap-4">
					<div class="min-w-0 space-y-2">
						<div class="flex flex-wrap items-center gap-2">
							<span
								class={[
									'inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold tracking-[0.14em] uppercase',
									getStatusClasses(selectedThread.status)
								]}
							>
								{getStatusLabel(selectedThread.status)}
							</span>
						</div>
						<h2 class="bc-title truncate text-2xl">{getThreadLabel(selectedThread)}</h2>
					</div>

					<button
						type="button"
						class="bc-btn shrink-0"
						onclick={() => openInChat(selectedThread.threadId)}
					>
						Open in chat
					</button>
				</div>

				<div class="mt-5 grid gap-3 text-sm text-[hsl(var(--bc-fg-muted))] md:grid-cols-4">
					<div class="bc-card p-3">
						<p class="text-sm font-semibold text-[hsl(var(--bc-fg-muted))]">Thread ID</p>
						<p class="mt-2 truncate font-mono text-xs text-[hsl(var(--bc-fg))]">
							{selectedThread.threadId}
						</p>
					</div>
					<div class="bc-card p-3">
						<p class="text-sm font-semibold text-[hsl(var(--bc-fg-muted))]">Last Updated</p>
						<p class="mt-2 text-[hsl(var(--bc-fg))]">{formatFullDate(selectedThread.updatedAt)}</p>
					</div>
					<div class="bc-card p-3">
						<p class="text-sm font-semibold text-[hsl(var(--bc-fg-muted))]">Messages</p>
						<p class="mt-2 text-[hsl(var(--bc-fg))]">{selectedThread.messageCount}</p>
					</div>
					<div class="bc-card p-3">
						<p class="text-sm font-semibold text-[hsl(var(--bc-fg-muted))]">Sandbox</p>
						<p class="mt-2 truncate text-[hsl(var(--bc-fg))]">
							{selectedThread.sandboxId ?? 'Not assigned yet'}
						</p>
					</div>
				</div>
			</div>

			<div class="bc-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
				{#if threadQuery.isLoading}
					<div class="bc-card p-4 text-sm text-[hsl(var(--bc-fg-muted))]">
						Loading transcript...
					</div>
				{:else if threadQuery.error}
					<div
						class="bc-card border-[hsl(var(--bc-error))] p-4 text-sm text-[hsl(var(--bc-error))]"
					>
						{getHumanErrorMessage(threadQuery.error, 'Failed to load the MCP transcript.')}
					</div>
				{:else if timelineItems.length === 0}
					<div class="bc-card border-dashed p-4 text-sm text-[hsl(var(--bc-fg-muted))]">
						No messages yet.
					</div>
				{:else}
					{#each timelineItems as item (item.id)}
						<article
							class={[
								'bc-card max-w-4xl space-y-3 p-4',
								item.role === 'user' && 'border-sky-500/30',
								item.role === 'assistant' && 'border-[hsl(var(--bc-border))]',
								item.role === 'tool' && !item.isError && 'border-amber-500/30',
								item.role === 'tool' && item.isError && 'border-rose-500/40'
							]}
						>
							<div class="flex items-center justify-between gap-3">
								<div class="flex items-center gap-2">
									<span class="text-sm font-semibold text-[hsl(var(--bc-fg))]">{item.title}</span>
									{#if item.isError}
										<span
											class="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.14em] text-rose-200 uppercase"
										>
											Error
										</span>
									{/if}
								</div>
								<span class="text-xs text-[hsl(var(--bc-fg-muted))]">
									{formatFullDate(item.timestamp)}
								</span>
							</div>

							<pre
								class="overflow-x-auto font-mono text-xs leading-6 break-words whitespace-pre-wrap text-[hsl(var(--bc-fg))]">
{item.body}
							</pre>
						</article>
					{/each}
				{/if}
			</div>
		{/if}
	</section>
</div>

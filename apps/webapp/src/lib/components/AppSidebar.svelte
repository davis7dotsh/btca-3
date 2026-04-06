<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import {
		Bot,
		BookOpen,
		ChevronDown,
		Command,
		CreditCard,
		MessageSquare,
		Moon,
		PanelLeftClose,
		Plus,
		Server,
		Sun,
		Trash2
	} from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '@btca/convex/api';
	import { getHumanErrorMessage } from '$lib/errors';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import type { AgentThreadListItem } from '$lib/types/agent';

	type QueryState<T> = {
		data: T | undefined;
		isLoading: boolean;
		error: unknown;
	};

	interface Props {
		isOpen?: boolean;
		onOpenCommandPalette?: () => void;
		onClose?: () => void;
	}

	let {
		isOpen = false,
		onOpenCommandPalette = () => {},
		onClose = () => {}
	}: Props = $props();

	const authContext = getAuthContext();
	const convex = browser ? useConvexClient() : null;

	const displayName = $derived(
		authContext.currentUser?.firstName ?? authContext.currentUser?.email ?? 'User'
	);
	const profilePicture = $derived(authContext.currentUser?.profilePictureUrl ?? null);

	const timestampFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric'
	});

	const shortenId = (value: string) => value.slice(0, 8);

	const threadsQuery: QueryState<AgentThreadListItem[]> = browser
		? useQuery(
				api.authed.agentThreads.list,
				() => (authContext.currentUser ? {} : 'skip'),
				() => ({ keepPreviousData: true })
			)
		: {
				data: undefined,
				isLoading: false,
				error: null
			};

	const threadItems = $derived(threadsQuery.data ?? []);
	const chatPath = resolve('/app/chat');
	const mcpPath = resolve('/app/mcp');
	const resourcesPath = resolve('/app/resources');
	const billingPath = resolve('/app/billing');
	const appHomePath = resolve('/app');
	const isOnPiChat = $derived(
		page.url.pathname === chatPath || page.url.pathname.startsWith(`${chatPath}/`)
	);
	const isOnAnyChat = $derived(isOnPiChat);
	const activeChatPath = $derived(chatPath);
	const currentThreadId = $derived(isOnAnyChat ? (page.params.id ?? null) : null);

	let threadMenuOpen = $state<string | null>(null);
	let userMenuOpen = $state(false);
	let pendingThreadId = $state<string | null>(null);
	const visibleCurrentThreadId = $derived(pendingThreadId ?? currentThreadId);
	const preloadedThreadUnsubscribes = new Map<string, () => void>();
	const preloadedThreadTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

	function getThreadLabel(thread: AgentThreadListItem) {
		return thread.title?.trim() || `Thread ${shortenId(thread.threadId)}`;
	}

	function formatTimestamp(timestamp: number) {
		return timestampFormatter.format(timestamp);
	}

	function getThreadPath(threadId: string) {
		return resolve(`/app/chat/${encodeURIComponent(threadId)}`);
	}

	function openThread(threadId: string) {
		pendingThreadId = threadId;
		onClose();
	}

	function clearThreadPrefetch(threadId: string) {
		const timeout = preloadedThreadTimeouts.get(threadId);

		if (timeout) {
			clearTimeout(timeout);
			preloadedThreadTimeouts.delete(threadId);
		}

		const unsubscribe = preloadedThreadUnsubscribes.get(threadId);

		if (unsubscribe) {
			unsubscribe();
			preloadedThreadUnsubscribes.delete(threadId);
		}
	}

	function prefetchThread(threadId: string) {
		if (!convex || !authContext.currentUser || threadId === currentThreadId) {
			return;
		}

		if (!preloadedThreadUnsubscribes.has(threadId)) {
			const unsubscribe = convex.onUpdate(
				api.authed.agentThreads.get,
				{ threadId },
				() => {},
				(error) => {
					console.warn('Failed to prefetch thread', { threadId, error });
				}
			);

			preloadedThreadUnsubscribes.set(threadId, unsubscribe);
		}

		const existingTimeout = preloadedThreadTimeouts.get(threadId);

		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		preloadedThreadTimeouts.set(
			threadId,
			setTimeout(() => {
				clearThreadPrefetch(threadId);
			}, 15_000)
		);
	}

	function newThread() {
		pendingThreadId = null;
		void goto(activeChatPath, { noScroll: true, keepFocus: true });
		onClose();
	}

	async function deleteThread(targetThreadId: string) {
		if (!convex) {
			return;
		}

		threadMenuOpen = null;

		try {
			await convex.mutation(api.authed.agentThreads.deleteThread, {
				threadId: targetThreadId
			});
		} catch (error) {
			console.error('Failed to delete thread', error);
			return;
		}

		if (targetThreadId === currentThreadId) {
			await goto(activeChatPath, { noScroll: true, keepFocus: true });
		}
	}

	function handleUserMenuKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			userMenuOpen = false;
		}
	}

	$effect(() => {
		if (!isOnAnyChat) {
			pendingThreadId = null;
			return;
		}

		if (pendingThreadId !== null && pendingThreadId === currentThreadId) {
			pendingThreadId = null;
		}
	});

	$effect(() => {
		const activeThreadIds = new Set(threadItems.map((thread) => thread.threadId));

		if (
			pendingThreadId !== null &&
			!activeThreadIds.has(pendingThreadId) &&
			pendingThreadId !== currentThreadId
		) {
			pendingThreadId = null;
		}
	});

	onDestroy(() => {
		for (const threadId of preloadedThreadUnsubscribes.keys()) {
			clearThreadPrefetch(threadId);
		}
	});
</script>

<aside
	class="bc-sidebar-shell flex h-full min-h-0 flex-col overflow-hidden"
>
	<div class="bc-sidebar-section">
		<div class="flex items-start justify-between gap-3">
			<a href={appHomePath} class="bc-chip w-full justify-start" onclick={onClose}>
				<div class="bc-logoMark h-11 w-11">
					<Bot size={18} strokeWidth={2.25} />
				</div>
				<div class="min-w-0">
					<div class="bc-title text-sm">btca web</div>
					<div class="bc-subtitle text-[11px]">search agent</div>
				</div>
			</a>

			{#if isOpen}
				<button
					type="button"
					class="bc-iconBtn shrink-0 lg:hidden"
					onclick={onClose}
					aria-label="Close sidebar"
				>
					<PanelLeftClose size={16} />
				</button>
			{/if}
		</div>
	</div>

	<div class="bc-sidebar-section">
		<button type="button" class="bc-btn bc-btn-primary w-full py-2.5 text-xs" onclick={newThread}>
			<Plus size={14} />
			New thread
		</button>

		<button
			type="button"
			class="bc-sidebar-search mt-3 w-full"
			onclick={onOpenCommandPalette}
			aria-label="Open command palette"
		>
			<Command size={14} class="shrink-0 text-[hsl(var(--bc-fg-muted))]" />
			<span class="bc-sidebar-search-input pointer-events-none select-none">Search actions</span>
			<kbd class="bc-sidebar-kbd">⌘K</kbd>
		</button>
	</div>

	<div class="bc-sidebar-section flex min-h-0 flex-1 flex-col overflow-hidden border-b-0 pb-0">
		<div class="mb-3 flex items-center gap-2">
			<div class="text-xs font-semibold text-[hsl(var(--bc-fg-muted))]">
				Recent Threads
			</div>
		</div>

		<div class="bc-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
		{#if threadsQuery.isLoading}
			<div class="p-3 text-xs text-[hsl(var(--bc-fg-muted))]">Loading...</div>
		{:else if threadsQuery.error}
			<div class="p-3 text-xs text-[hsl(var(--bc-error))]">
				{getHumanErrorMessage(threadsQuery.error, 'Failed to load threads.')}
			</div>
		{:else if threadItems.length === 0}
			<div class="p-3 text-xs text-[hsl(var(--bc-fg-muted))]">No threads yet.</div>
		{:else}
			{#each threadItems as thread (thread.threadId)}
				<div
					class={[
						'bc-threadItem group relative',
						isOnAnyChat && thread.threadId === visibleCurrentThreadId && 'bc-threadItem-active'
					]}
				>
					<a
						href={getThreadPath(thread.threadId)}
						data-sveltekit-preload-data="hover"
						class="bc-threadItemLink min-h-full min-w-0 flex-1 self-stretch pr-10 text-left"
						onmouseenter={() => prefetchThread(thread.threadId)}
						onfocus={() => prefetchThread(thread.threadId)}
						onpointerdown={() => prefetchThread(thread.threadId)}
						onclick={() => openThread(thread.threadId)}
					>
						<div class="truncate text-sm font-medium text-[hsl(var(--bc-fg))]">
							{getThreadLabel(thread)}
						</div>
						<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[hsl(var(--bc-fg-muted))]">
							{#if thread.status === 'running'}
								<span
									class="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--bc-accent)/0.24)] bg-[hsl(var(--bc-accent)/0.1)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-[hsl(var(--bc-accent))] uppercase"
								>
									<span class="h-1.5 w-1.5 rounded-full bg-current"></span>
									Running
								</span>
							{/if}
							<span>{formatTimestamp(thread.updatedAt)}</span>
							<span>{thread.userMessageCount} msgs</span>
							{#if thread.isMcp}
								<span
									class="inline-flex items-center border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.14em] text-[hsl(var(--bc-accent))] uppercase"
								>
									MCP
								</span>
							{/if}
						</div>
					</a>

					<div class="absolute top-2 right-2 z-10 shrink-0">
						<button
							type="button"
							class="bc-threadItemDelete"
							aria-label="Thread options"
							onclick={(e) => {
								e.stopPropagation();
								threadMenuOpen = threadMenuOpen === thread.threadId ? null : thread.threadId;
							}}
						>
							<Trash2 size={14} />
						</button>

						{#if threadMenuOpen === thread.threadId}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div class="thread-menu-backdrop" onclick={() => (threadMenuOpen = null)}></div>
							<div class="thread-menu-dropdown">
								<button
									type="button"
									class="thread-menu-action thread-menu-action-danger"
									onclick={(e) => {
										e.stopPropagation();
										void deleteThread(thread.threadId);
									}}
								>
									Delete
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		{/if}
		</div>
	</div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bc-sidebar-footer relative shrink-0 border-t border-[hsl(var(--bc-border))] px-4 py-3"
		onkeydown={handleUserMenuKeydown}
	>
		<button
			type="button"
			class="bc-chip w-full justify-start gap-3 text-left"
			onclick={() => (userMenuOpen = !userMenuOpen)}
		>
			{#if profilePicture}
				<img src={profilePicture} alt="" class="h-9 w-9 shrink-0 object-cover" />
			{:else}
				<div
					class="grid h-9 w-9 shrink-0 place-items-center border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface-2))] text-[11px] font-bold text-[hsl(var(--bc-fg-muted))] uppercase"
				>
					{displayName.charAt(0)}
				</div>
			{/if}
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium">{displayName}</div>
				<div class="truncate text-[11px] text-[hsl(var(--bc-fg-muted))]">
					Workspace shortcuts
				</div>
			</div>
			<ChevronDown
				size={14}
				class={['shrink-0 text-[hsl(var(--bc-fg-muted))] transition-transform duration-150', userMenuOpen && 'rotate-180']}
			/>
		</button>

		{#if userMenuOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="fixed inset-0 z-40" onclick={() => (userMenuOpen = false)}></div>
			<div class="user-menu-dropdown">
				<a href={resourcesPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
					<BookOpen size={14} />
					Resources
				</a>
				<a href={mcpPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
					<Server size={14} />
					MCP
				</a>
				<a href={billingPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
					<CreditCard size={14} />
					Billing
				</a>

				<div class="user-menu-divider"></div>

				<button
					type="button"
					class="user-menu-item w-full"
					onclick={() => {
						theme.toggle();
						userMenuOpen = false;
					}}
				>
					{#if theme.isDark}
						<Sun size={14} />
						Light mode
					{:else}
						<Moon size={14} />
						Dark mode
					{/if}
				</button>

				<div class="user-menu-divider"></div>

				<form method="POST" action="/auth/logout" class="contents">
					<input type="hidden" name="returnTo" value="/app" />
					<button type="submit" class="user-menu-item user-menu-item-danger w-full">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline
								points="16 17 21 12 16 7"
							/><line x1="21" y1="12" x2="9" y2="12" />
						</svg>
						Sign out
					</button>
				</form>
			</div>
		{/if}
	</div>
</aside>

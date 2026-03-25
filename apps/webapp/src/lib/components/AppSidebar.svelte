<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '@btca/convex/api';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import type { AgentThreadListItem } from '$lib/types/agent';

	const authContext = getAuthContext();
	const convex = useConvexClient();

	const displayName = $derived(
		authContext.currentUser?.firstName ?? authContext.currentUser?.email ?? 'User'
	);
	const profilePicture = $derived(authContext.currentUser?.profilePictureUrl ?? null);

	const timestampFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric'
	});

	const shortenId = (value: string) => value.slice(0, 8);

	const threadsQuery = useQuery(
		api.authed.agentThreads.list,
		() => (authContext.currentUser ? {} : 'skip'),
		() => ({ keepPreviousData: true })
	);

	const threadItems = $derived(threadsQuery.data ?? []);
	const chatPath = resolve('/app/chat');
	const boxChatPath = resolve('/app/box/chat');
	const boxHybridChatPath = resolve('/app/box-hybrid/chat');
	const mcpPath = resolve('/app/mcp');
	const resourcesPath = resolve('/app/resources');
	const settingsPath = resolve('/app/settings');
	const billingPath = resolve('/app/billing');
	const isOnPiChat = $derived(
		page.url.pathname === chatPath || page.url.pathname.startsWith(`${chatPath}/`)
	);
	const isOnBoxChat = $derived(
		page.url.pathname === boxChatPath || page.url.pathname.startsWith(`${boxChatPath}/`)
	);
	const isOnBoxHybridChat = $derived(
		page.url.pathname === boxHybridChatPath || page.url.pathname.startsWith(`${boxHybridChatPath}/`)
	);
	const isOnAnyChat = $derived(isOnPiChat || isOnBoxChat || isOnBoxHybridChat);
	const activeChatPath = $derived(
		isOnBoxChat ? boxChatPath : isOnBoxHybridChat ? boxHybridChatPath : chatPath
	);
	const currentThreadId = $derived(isOnAnyChat ? (page.params.id ?? null) : null);

	let threadMenuOpen = $state<string | null>(null);
	let userMenuOpen = $state(false);

	function getThreadLabel(thread: AgentThreadListItem) {
		return thread.title?.trim() || `Thread ${shortenId(thread.threadId)}`;
	}

	function formatTimestamp(timestamp: number) {
		return timestampFormatter.format(timestamp);
	}

	function getThreadPath(threadId: string) {
		if (isOnBoxChat) {
			return resolve(`/app/box/chat/${encodeURIComponent(threadId)}`);
		}

		if (isOnBoxHybridChat) {
			return resolve(`/app/box-hybrid/chat/${encodeURIComponent(threadId)}`);
		}

		return resolve(`/app/chat/${encodeURIComponent(threadId)}`);
	}

	function openThread(threadId: string) {
		void goto(getThreadPath(threadId), {
			noScroll: true,
			keepFocus: true
		});
	}

	function newThread() {
		void goto(activeChatPath, { noScroll: true, keepFocus: true });
	}

	async function deleteThread(targetThreadId: string) {
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
</script>

<aside
	class="flex w-56 shrink-0 flex-col border-r border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))]"
>
	<div class="grid grid-cols-3 gap-2 px-3 pt-3">
		<a href={chatPath} class={['bc-btn justify-center text-xs', isOnPiChat && 'bc-btn-primary']}>
			Pi Chat
		</a>
		<a
			href={boxChatPath}
			class={['bc-btn justify-center text-xs', isOnBoxChat && 'bc-btn-primary']}
		>
			Box Chat
		</a>
		<a
			href={boxHybridChatPath}
			class={['bc-btn justify-center text-xs', isOnBoxHybridChat && 'bc-btn-primary']}
		>
			Box Hybrid
		</a>
	</div>

	<div class="px-3 pt-2 pb-1">
		<button type="button" class="bc-btn w-full" onclick={newThread}> New thread </button>
	</div>

	<div class="bc-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-2 pr-2">
		{#if threadsQuery.isLoading}
			<div class="p-3 text-xs text-[hsl(var(--bc-fg-muted))]">Loading...</div>
		{:else if threadsQuery.error}
			<div class="p-3 text-xs text-[hsl(var(--bc-error))]">
				{threadsQuery.error.message}
			</div>
		{:else if threadItems.length === 0}
			<div class="p-3 text-xs text-[hsl(var(--bc-fg-muted))]">No threads yet.</div>
		{:else}
			{#each threadItems as thread (thread.threadId)}
				<div
					class="thread-item group"
					class:thread-item-active={isOnAnyChat && thread.threadId === currentThreadId}
				>
					<button
						type="button"
						class="thread-item-body"
						onclick={() => openThread(thread.threadId)}
					>
						<div class="truncate text-xs font-medium text-[hsl(var(--bc-fg))]">
							{getThreadLabel(thread)}
						</div>
						<div class="mt-0.5 text-[11px] text-[hsl(var(--bc-fg-muted))]">
							{thread.messageCount} msgs · {formatTimestamp(thread.updatedAt)}
							{#if thread.isMcp}
								<span
									class="ml-1 inline-flex items-center border border-[hsl(var(--bc-border))] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.14em] text-[hsl(var(--bc-accent))] uppercase"
								>
									MCP
								</span>
							{/if}
						</div>
					</button>

					<div class="relative shrink-0">
						<button
							type="button"
							class="thread-menu-trigger"
							aria-label="Thread options"
							onclick={(e) => {
								e.stopPropagation();
								threadMenuOpen = threadMenuOpen === thread.threadId ? null : thread.threadId;
							}}
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
								<circle cx="12" cy="5" r="2" />
								<circle cx="12" cy="12" r="2" />
								<circle cx="12" cy="19" r="2" />
							</svg>
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

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="relative border-t border-[hsl(var(--bc-border))] px-3 py-3"
		onkeydown={handleUserMenuKeydown}
	>
		<button
			type="button"
			class="flex w-full items-center gap-2.5 text-left transition hover:opacity-80"
			onclick={() => (userMenuOpen = !userMenuOpen)}
		>
			{#if profilePicture}
				<img src={profilePicture} alt="" class="h-7 w-7 shrink-0 object-cover" />
			{:else}
				<div
					class="grid h-7 w-7 shrink-0 place-items-center border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface-2))] text-[10px] font-bold text-[hsl(var(--bc-fg-muted))] uppercase"
				>
					{displayName.charAt(0)}
				</div>
			{/if}
			<span class="min-w-0 flex-1 truncate text-sm font-medium">{displayName}</span>
			<svg
				class="shrink-0 text-[hsl(var(--bc-fg-muted))] transition-transform duration-150"
				class:rotate-180={userMenuOpen}
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
		</button>

		{#if userMenuOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="fixed inset-0 z-40" onclick={() => (userMenuOpen = false)}></div>
			<div class="user-menu-dropdown">
				<a href={resourcesPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
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
						<path
							d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"
						/>
					</svg>
					Resources
				</a>
				<a href={mcpPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
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
						<rect x="3" y="4" width="18" height="6" rx="2" /><rect
							x="3"
							y="14"
							width="18"
							height="6"
							rx="2"
						/><path d="M7 7h.01" /><path d="M7 17h.01" /><path d="M11 7h6" /><path d="M11 17h6" />
					</svg>
					MCP
				</a>
				<a href={settingsPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
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
						<circle cx="12" cy="12" r="3" /><path
							d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 20a1.65 1.65 0 0 0-1-.6 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1-.33H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4 9a1.65 1.65 0 0 0 .6-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4a1.65 1.65 0 0 0 1 .6 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.3.3.49.67.6 1 .07.34.33.58.67.67H21a2 2 0 0 1 0 4h-.09c-.34.07-.58.33-.67.67-.11.33-.3.7-.6 1Z"
						/>
					</svg>
					Settings
				</a>
				<a href={billingPath} class="user-menu-item" onclick={() => (userMenuOpen = false)}>
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
						<rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" />
					</svg>
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
							<circle cx="12" cy="12" r="5" /><path d="M12 1v2" /><path d="M12 21v2" /><path
								d="m4.22 4.22 1.42 1.42"
							/><path d="m18.36 18.36 1.42 1.42" /><path d="M1 12h2" /><path d="M21 12h2" /><path
								d="m4.22 19.78 1.42-1.42"
							/><path d="m18.36 5.64 1.42-1.42" />
						</svg>
						Light mode
					{:else}
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
							<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
						</svg>
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

<script lang="ts">
	import { browser } from '$app/environment';
	import {
		BookOpen,
		Command,
		CornerDownLeft,
		CreditCard,
		MessageSquare,
		Moon,
		Plus,
		Search,
		Server,
		Sun
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useQuery } from 'convex-svelte';
	import { api } from '@btca/convex/api';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import type { AgentThreadListItem } from '$lib/types/agent';

	type CommandItem = {
		id: string;
		group: string;
		label: string;
		sublabel?: string;
		icon: typeof Search;
		onSelect: () => void;
	};

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	type QueryState<T> = {
		data: T | undefined;
		isLoading: boolean;
		error: unknown;
	};

	let { isOpen, onClose }: Props = $props();

	const authContext = getAuthContext();
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
	const threads = $derived(threadsQuery.data ?? []);

	const maxVisibleThreads = 5;
	const timestampFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric'
	});

	let searchQuery = $state('');
	let selectedIndex = $state(0);
	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let listEl = $state<HTMLDivElement | undefined>(undefined);

	$effect(() => {
		if (!isOpen) {
			return;
		}

		searchQuery = '';
		selectedIndex = 0;
		setTimeout(() => inputEl?.focus(), 10);
	});

	const allItems = $derived.by((): CommandItem[] => {
		const query = searchQuery.trim().toLowerCase();

		const threadItems = (!query
			? threads
			: threads.filter((thread) =>
					(thread.title?.trim() || `Thread ${thread.threadId.slice(0, 8)}`).toLowerCase().includes(query)
				)
		)
			.slice(0, maxVisibleThreads)
			.map((thread) => ({
				id: `thread-${thread.threadId}`,
				group: 'Threads',
				label: thread.title?.trim() || `Thread ${thread.threadId.slice(0, 8)}`,
				sublabel: `${thread.userMessageCount} msgs · ${timestampFormatter.format(thread.updatedAt)}`,
				icon: MessageSquare,
				onSelect: () => {
					void goto(resolve(`/app/chat/${encodeURIComponent(thread.threadId)}`), {
						noScroll: true,
						keepFocus: true
					});
					onClose();
				}
			}));

		const actions: CommandItem[] = [
			{
				id: 'new-thread',
				group: 'Actions',
				label: 'New thread',
				sublabel: 'Start a fresh conversation',
				icon: Plus,
				onSelect: () => {
					void goto(resolve('/app/chat'), { noScroll: true, keepFocus: true });
					onClose();
				}
			},
			{
				id: 'toggle-theme',
				group: 'Actions',
				label: theme.isDark ? 'Switch to light mode' : 'Switch to dark mode',
				sublabel: 'Update the app theme',
				icon: theme.isDark ? Sun : Moon,
				onSelect: () => {
					theme.toggle();
					onClose();
				}
			}
		];

		const destinations: CommandItem[] = [
			{
				id: 'go-chat',
				group: 'Navigate',
				label: 'Chat',
				sublabel: 'Recent threads and agents',
				icon: MessageSquare,
				onSelect: () => {
					void goto(resolve('/app/chat'), { noScroll: true, keepFocus: true });
					onClose();
				}
			},
			{
				id: 'go-resources',
				group: 'Navigate',
				label: 'Resources',
				sublabel: 'Manage context and sources',
				icon: BookOpen,
				onSelect: () => {
					void goto(resolve('/app/resources'));
					onClose();
				}
			},
			{
				id: 'go-mcp',
				group: 'Navigate',
				label: 'MCP',
				sublabel: 'Browse MCP setup and tools',
				icon: Server,
				onSelect: () => {
					void goto(resolve('/app/mcp'));
					onClose();
				}
			},
			{
				id: 'go-billing',
				group: 'Navigate',
				label: 'Billing',
				sublabel: 'Plan and usage details',
				icon: CreditCard,
				onSelect: () => {
					void goto(resolve('/app/billing'));
					onClose();
				}
			}
		];

		const nonThreadItems = [...actions, ...destinations];
		const filteredNonThread = query
			? nonThreadItems.filter(
					(item) =>
						item.label.toLowerCase().includes(query) ||
						item.sublabel?.toLowerCase().includes(query) ||
						item.group.toLowerCase().includes(query)
				)
			: nonThreadItems;

		return [...threadItems, ...filteredNonThread];
	});

	const groupedItems = $derived.by(() => {
		const groups: { name: string; items: (CommandItem & { globalIndex: number })[] }[] = [];
		let globalIndex = 0;

		for (const item of allItems) {
			let group = groups.find(({ name }) => name === item.group);
			if (!group) {
				group = { name: item.group, items: [] };
				groups.push(group);
			}

			group.items.push({ ...item, globalIndex });
			globalIndex += 1;
		}

		return groups;
	});

	$effect(() => {
		const selected = selectedIndex;
		const el = listEl?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	function handleKeydown(event: KeyboardEvent) {
		if (!isOpen) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}

		if (allItems.length === 0) {
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, allItems.length - 1);
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			allItems[selectedIndex]?.onSelect();
		}
	}
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-[hsl(var(--bc-bg))]/78 px-4 pt-[10vh] backdrop-blur-sm"
		role="presentation"
		onclick={onClose}
	>
		<div
			class="bc-card relative flex w-full max-w-[560px] flex-col overflow-hidden shadow-[0_24px_80px_hsl(var(--bc-shadow)/0.5)]"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			tabindex="-1"
			onclick={(event) => event.stopPropagation()}
			onkeydown={handleKeydown}
		>
			<div class="flex items-center gap-3 border-b border-[hsl(var(--bc-border))] px-4 py-3">
				<div
					class="grid h-8 w-8 shrink-0 place-items-center border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface-2))] text-[hsl(var(--bc-fg-muted))]"
				>
					<Search size={15} />
				</div>
				<input
					bind:this={inputEl}
					type="text"
					class="min-w-0 flex-1 bg-transparent text-sm text-[hsl(var(--bc-fg))] placeholder:text-[hsl(var(--bc-fg-muted))] focus:outline-none"
					placeholder="Search threads, actions, pages..."
					bind:value={searchQuery}
					oninput={() => (selectedIndex = 0)}
					aria-label="Search commands"
					autocomplete="off"
					spellcheck="false"
				/>
				<button type="button" class="bc-commandPaletteKey" onclick={onClose}>Esc</button>
			</div>

			<div bind:this={listEl} class="max-h-[min(28rem,60vh)] overflow-y-auto py-2" role="listbox">
				{#if allItems.length === 0}
					<div class="px-5 py-12 text-center text-sm text-[hsl(var(--bc-fg-muted))]">
						No results for
						<span class="font-medium text-[hsl(var(--bc-fg))]">"{searchQuery}"</span>
					</div>
				{:else}
					{#each groupedItems as group (group.name)}
						<div
							class="px-5 pb-1 pt-3 text-xs font-semibold text-[hsl(var(--bc-fg-muted))]"
						>
							{group.name}
						</div>

						{#each group.items as item (item.id)}
							{@const Icon = item.icon}
							{@const isSelected = item.globalIndex === selectedIndex}
							<button
								type="button"
								data-index={item.globalIndex}
								class={[
									'bc-commandPaletteItem',
									isSelected && 'bc-commandPaletteItem-active'
								]}
								role="option"
								aria-selected={isSelected}
								onclick={() => item.onSelect()}
								onmouseenter={() => (selectedIndex = item.globalIndex)}
							>
								<div
									class={[
										'bc-commandPaletteIcon',
										isSelected && 'bc-commandPaletteIcon-active'
									]}
								>
									<Icon size={15} />
								</div>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium text-[hsl(var(--bc-fg))]">
										{item.label}
									</div>
									{#if item.sublabel}
										<div class="truncate text-[11px] text-[hsl(var(--bc-fg-muted))]">
											{item.sublabel}
										</div>
									{/if}
								</div>
							</button>
						{/each}
					{/each}
				{/if}
			</div>

			<div
				class="flex flex-wrap items-center gap-4 border-t border-[hsl(var(--bc-border))] px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-[hsl(var(--bc-fg-muted))]"
			>
				<span class="flex items-center gap-1.5">
					<kbd class="bc-commandPaletteKey">↑↓</kbd>
					move
				</span>
				<span class="flex items-center gap-1.5">
					<kbd class="bc-commandPaletteKey">
						<CornerDownLeft size={11} />
					</kbd>
					open
				</span>
				<span class="flex items-center gap-1.5">
					<kbd class="bc-commandPaletteKey">
						<Command size={11} />
						K
					</kbd>
					toggle
				</span>
			</div>
		</div>
	</div>
{/if}

<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import type { Id } from '@btca/convex/data-model';
	import { api } from '@btca/convex/api';
	import { getHumanErrorMessage } from '$lib/errors';
	import { getResourceNameError } from '$lib/resources';
	import { getAuthContext } from '$lib/stores/auth.svelte';

	type QueryState<T> = {
		data: T | undefined;
		isLoading: boolean;
		error: unknown;
	};

	type ItemDraft = {
		name: string;
		description: string;
		url: string;
	};

	type ResourceItemView = {
		id: string;
		name: string;
		description: string | null;
		url: string;
		iconUrl: string | null;
	};

	const getHostedFaviconUrl = (url: string) => {
		try {
			const parsed = new URL(url);
			return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=64`;
		} catch {
			return null;
		}
	};

	const getDisplayIconUrl = (item: ResourceItemView) => item.iconUrl ?? getHostedFaviconUrl(item.url);

	const authContext = getAuthContext();
	const convex = browser ? useConvexClient() : null;

	const resourceId = $derived(page.params.id as Id<'resources'> | undefined);

	let syncedResourceId = $state<string | null>(null);
	let resourceName = $state('');
	let resourceError = $state<string | null>(null);
	let itemError = $state<string | null>(null);
	let isSavingResource = $state(false);
	let isDeletingResource = $state(false);
	let editingItemId = $state<string | null>(null);
	let activeItemMutationId = $state<string | null>(null);
	let refreshingItemIconId = $state<string | null>(null);
	let itemDrafts = $state<Record<string, ItemDraft>>({});
	let newItemName = $state('');
	let newItemDescription = $state('');
	let newItemUrl = $state('');
	let isCreatingItem = $state(false);

	const resourceQuery: QueryState<
		| {
				resource: {
					id: string;
					name: string;
					createdAt: number;
					updatedAt: number;
				};
				items: ResourceItemView[];
		  }
		| null
	> = browser
		? useQuery(
				api.authed.resources.get,
				() => (authContext.currentUser && resourceId ? { resourceId } : 'skip'),
				() => ({ keepPreviousData: true })
			)
		: {
				data: undefined,
				isLoading: false,
				error: null
			};

	const items = $derived(resourceQuery.data?.items ?? []);

	const createDraft = (item: ResourceItemView): ItemDraft => ({
		name: item.name,
		description: item.description ?? '',
		url: item.url
	});

	$effect(() => {
		const data = resourceQuery.data;

		if (!data || data.resource.id === syncedResourceId) {
			return;
		}

		syncedResourceId = data.resource.id;
		resourceName = data.resource.name;
		itemDrafts = Object.fromEntries(data.items.map((item) => [item.id, createDraft(item)]));
		editingItemId = null;
	});

	function resetNewItemForm() {
		newItemName = '';
		newItemDescription = '';
		newItemUrl = '';
	}

	function beginItemEdit(item: ResourceItemView) {
		itemDrafts[item.id] = createDraft(item);
		editingItemId = item.id;
		itemError = null;
	}

	function cancelItemEdit(item: ResourceItemView) {
		itemDrafts[item.id] = createDraft(item);
		editingItemId = null;
		itemError = null;
	}

	async function saveResource() {
		if (!resourceId || isSavingResource || !convex) {
			return;
		}

		resourceError = getResourceNameError(resourceName);

		if (resourceError) {
			return;
		}

		isSavingResource = true;

		try {
			await convex.mutation(api.authed.resources.update, {
				resourceId,
				name: resourceName
			});
		} catch (error) {
			resourceError = getHumanErrorMessage(error, 'Failed to save the resource.');
		} finally {
			isSavingResource = false;
		}
	}

	async function deleteResource() {
		if (!resourceId || isDeletingResource || !convex) {
			return;
		}

		if (!confirm('Delete this resource and all of its items?')) {
			return;
		}

		resourceError = null;
		isDeletingResource = true;

		try {
			await convex.mutation(api.authed.resources.remove, { resourceId });
			await goto(resolve('/app/resources'));
		} catch (error) {
			resourceError = getHumanErrorMessage(error, 'Failed to delete the resource.');
		} finally {
			isDeletingResource = false;
		}
	}

	async function createItem() {
		if (!resourceId || isCreatingItem || !convex) {
			return;
		}

		itemError = null;
		isCreatingItem = true;

		try {
			await convex.mutation(api.authed.resources.createItem, {
				resourceId,
				name: newItemName,
				description: newItemDescription.trim() || undefined,
				url: newItemUrl
			});
			resetNewItemForm();
		} catch (error) {
			itemError = getHumanErrorMessage(error, 'Failed to create the resource item.');
		} finally {
			isCreatingItem = false;
		}
	}

	async function saveItem(itemId: string) {
		const draft = itemDrafts[itemId];

		if (!draft || activeItemMutationId !== null || !convex) {
			return;
		}

		itemError = null;
		activeItemMutationId = itemId;

		try {
			await convex.mutation(api.authed.resources.updateItem, {
				itemId: itemId as Id<'resourceItems'>,
				name: draft.name,
				description: draft.description.trim() || undefined,
				url: draft.url
			});
			editingItemId = null;
		} catch (error) {
			itemError = getHumanErrorMessage(error, 'Failed to update the resource item.');
		} finally {
			activeItemMutationId = null;
		}
	}

	async function deleteItem(itemId: string) {
		if (activeItemMutationId !== null || !convex) {
			return;
		}

		itemError = null;
		activeItemMutationId = itemId;

		try {
			await convex.mutation(api.authed.resources.removeItem, {
				itemId: itemId as Id<'resourceItems'>
			});

			if (editingItemId === itemId) {
				editingItemId = null;
			}
		} catch (error) {
			itemError = getHumanErrorMessage(error, 'Failed to remove the resource item.');
		} finally {
			activeItemMutationId = null;
		}
	}

	async function refreshItemIcon(itemId: string) {
		if (refreshingItemIconId !== null || !convex) {
			return;
		}

		itemError = null;
		refreshingItemIconId = itemId;

		try {
			await convex.mutation(api.authed.resources.refreshItemIcon, {
				itemId: itemId as Id<'resourceItems'>
			});
		} catch (error) {
			itemError = getHumanErrorMessage(error, 'Failed to refresh the item icon.');
		} finally {
			refreshingItemIconId = null;
		}
	}

	async function moveItem(itemId: string, direction: -1 | 1) {
		if (!resourceId || activeItemMutationId !== null || !convex) {
			return;
		}

		const currentItems = [...items];
		const currentIndex = currentItems.findIndex((item) => item.id === itemId);
		const nextIndex = currentIndex + direction;

		if (currentIndex === -1 || nextIndex < 0 || nextIndex >= currentItems.length) {
			return;
		}

		const reorderedItems = [...currentItems];
		const [movedItem] = reorderedItems.splice(currentIndex, 1);
		reorderedItems.splice(nextIndex, 0, movedItem);
		activeItemMutationId = itemId;
		itemError = null;

		try {
			await convex.mutation(api.authed.resources.reorderItems, {
				resourceId,
				itemIds: reorderedItems.map((item) => item.id as Id<'resourceItems'>)
			});
		} catch (error) {
			itemError = getHumanErrorMessage(error, 'Failed to reorder the resource items.');
		} finally {
			activeItemMutationId = null;
		}
	}
</script>

<div class="bc-scrollbar flex flex-1 flex-col overflow-y-auto">
	<div class="bc-reveal mx-auto w-full max-w-5xl space-y-6 p-6">
		<header class="space-y-2">
			<nav class="flex items-center gap-1.5 text-xs text-[hsl(var(--bc-fg-muted))]">
				<a href={resolve('/app/resources')} class="transition hover:text-[hsl(var(--bc-fg))]">
					Resources
				</a>
				<span>/</span>
				<span class="text-[hsl(var(--bc-fg))]">
					{resourceQuery.data?.resource.name ?? '...'}
				</span>
			</nav>
			<h1 class="bc-title text-2xl">
				@{resourceQuery.data?.resource.name ?? 'loading'}
			</h1>
		</header>

		{#if resourceQuery.isLoading}
			<div class="bc-card p-5">
				<p class="bc-muted text-sm">Loading resource...</p>
			</div>
		{:else if resourceQuery.error}
			<div class="bc-card p-5">
				<p class="text-sm text-red-500">
					{getHumanErrorMessage(resourceQuery.error, 'Failed to load the resource.')}
				</p>
			</div>
		{:else if resourceQuery.data === null}
			<div class="bc-card p-5">
				<p class="text-sm text-red-500">Resource not found.</p>
			</div>
		{:else}
			<div class="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
				<section class="bc-card self-start p-5">
					<h2 class="bc-title text-base">Details</h2>

					<div class="mt-4 space-y-4">
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Name</span>
							<input
								bind:value={resourceName}
								oninput={() => (resourceError = null)}
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="svelte"
							/>
							<p class="bc-muted text-xs">This is the exact `@mention` token.</p>
						</label>

						{#if resourceError}
							<p class="text-sm text-red-500">{resourceError}</p>
						{/if}

						<div class="flex flex-wrap gap-3">
							<button type="button" class="bc-btn flex-1" onclick={() => void saveResource()}>
								{isSavingResource ? 'Saving...' : 'Save'}
							</button>
							<button
								type="button"
								class="bc-btn bg-red-500/12 text-red-500"
								onclick={() => void deleteResource()}
							>
								{isDeletingResource ? 'Deleting...' : 'Delete'}
							</button>
						</div>
					</div>
				</section>

				<section class="space-y-4">
					<div class="flex items-baseline justify-between gap-3">
						<h2 class="bc-title text-base">Items</h2>
						<span class="text-sm text-[hsl(var(--bc-fg-muted))]">
							{items.length} total
						</span>
					</div>

					<div
						class="grid gap-4 border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] p-4"
					>
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Name</span>
							<input
								bind:value={newItemName}
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="Svelte docs"
							/>
						</label>

						<label class="block space-y-1.5">
							<span class="text-sm font-medium">URL</span>
							<input
								bind:value={newItemUrl}
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="https://svelte.dev"
							/>
						</label>

						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Description</span>
							<textarea
								bind:value={newItemDescription}
								class="bc-scrollbar min-h-20 w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="Optional guidance for what the agent should use this URL for."
							></textarea>
						</label>

						<div class="flex items-center justify-between gap-3">
							{#if itemError}
								<p class="text-sm text-red-500">{itemError}</p>
							{/if}

							<button type="button" class="bc-btn ml-auto" onclick={() => void createItem()}>
								{isCreatingItem ? 'Adding...' : 'Add item'}
							</button>
						</div>
					</div>

					{#if items.length === 0}
						<div class="border border-dashed border-[hsl(var(--bc-border))] p-8 text-center">
							<p class="bc-muted text-sm">No items yet.</p>
						</div>
					{:else}
						<div class="space-y-2">
							{#each items as item, index (item.id)}
								<div class="border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] p-4">
									{#if editingItemId === item.id}
										<div class="grid gap-4">
											<label class="block space-y-1.5">
												<span class="text-sm font-medium">Name</span>
												<input
													bind:value={itemDrafts[item.id].name}
													class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												/>
											</label>

											<label class="block space-y-1.5">
												<span class="text-sm font-medium">URL</span>
												<input
													bind:value={itemDrafts[item.id].url}
													class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												/>
											</label>

											<label class="block space-y-1.5">
												<span class="text-sm font-medium">Description</span>
												<textarea
													bind:value={itemDrafts[item.id].description}
													class="bc-scrollbar min-h-20 w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												></textarea>
											</label>
										</div>

										<div class="mt-4 flex flex-wrap gap-3">
											<button type="button" class="bc-btn" onclick={() => void saveItem(item.id)}>
												{activeItemMutationId === item.id ? 'Saving...' : 'Save'}
											</button>
											<button
												type="button"
												class="bc-btn bg-[hsl(var(--bc-surface))]"
												onclick={() => cancelItemEdit(item)}
											>
												Cancel
											</button>
										</div>
									{:else}
										<div class="flex items-start justify-between gap-4">
											<div class="min-w-0 space-y-2">
												<div class="flex items-center gap-3">
													{#if item.iconUrl}
														<img
															src={getDisplayIconUrl(item) ?? undefined}
															alt=""
															class="h-5 w-5 rounded-sm border border-[hsl(var(--bc-border))] bg-white object-contain"
															onerror={(event) => {
																const fallbackUrl = getHostedFaviconUrl(item.url);
																const image = event.currentTarget as HTMLImageElement;

																if (fallbackUrl && image.src !== fallbackUrl) {
																	image.src = fallbackUrl;
																	return;
																}

																image.style.display = 'none';
															}}
														/>
													{/if}
													<h3 class="font-semibold">{item.name}</h3>
												</div>
												{#if item.description}
													<p class="bc-muted text-sm leading-6">{item.description}</p>
												{/if}
												<button
													type="button"
													class="text-left text-xs text-[hsl(var(--bc-fg-muted))] transition hover:text-[hsl(var(--bc-fg))]"
													onclick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
												>
													{item.url}
												</button>
											</div>

											<div class="flex shrink-0 items-center gap-1">
												<button
													type="button"
													class="bc-btn px-2.5 py-1.5 text-xs"
													disabled={refreshingItemIconId !== null}
													onclick={() => void refreshItemIcon(item.id)}
												>
													{refreshingItemIconId === item.id ? '...' : 'Icon'}
												</button>
												<button
													type="button"
													class="bc-btn px-2.5 py-1.5 text-xs"
													disabled={index === 0 || activeItemMutationId !== null}
													onclick={() => void moveItem(item.id, -1)}
												>
													↑
												</button>
												<button
													type="button"
													class="bc-btn px-2.5 py-1.5 text-xs"
													disabled={index === items.length - 1 || activeItemMutationId !== null}
													onclick={() => void moveItem(item.id, 1)}
												>
													↓
												</button>
												<button
													type="button"
													class="bc-btn px-2.5 py-1.5 text-xs"
													onclick={() => beginItemEdit(item)}
												>
													Edit
												</button>
												<button
													type="button"
													class="bc-btn bg-red-500/12 px-2.5 py-1.5 text-xs text-red-500"
													onclick={() => void deleteItem(item.id)}
												>
													{activeItemMutationId === item.id ? '...' : 'Remove'}
												</button>
											</div>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</div>
</div>

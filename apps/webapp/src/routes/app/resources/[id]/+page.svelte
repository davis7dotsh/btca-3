<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import type { Id } from '@btca/convex/data-model';
	import { api } from '@btca/convex/api';
	import { resourceItemKindLabels } from '$lib/resources';
	import { resourceItemKinds, type ResourceItemKind } from '$lib/types/resources';
	import { getAuthContext } from '$lib/stores/auth.svelte';

	const authContext = getAuthContext();
	const convex = useConvexClient();

	type ItemDraft = {
		kind: ResourceItemKind;
		name: string;
		description: string;
		url: string;
		branch: string;
		packageName: string;
	};

	type ResourceItemView = {
		id: string;
		kind: ResourceItemKind;
		name: string;
		description: string;
		url: string;
		branch: string | null;
		packageName: string | null;
	};

	const resourceId = $derived(page.params.id as Id<'resources'> | undefined);

	let syncedResourceId = $state<string | null>(null);
	let resourceName = $state('');
	let resourceSlug = $state('');
	let resourceNotes = $state('');
	let resourceError = $state<string | null>(null);
	let itemError = $state<string | null>(null);
	let isSavingResource = $state(false);
	let isDeletingResource = $state(false);
	let editingItemId = $state<string | null>(null);
	let activeItemMutationId = $state<string | null>(null);
	let itemDrafts = $state<Record<string, ItemDraft>>({});
	let newItemKind = $state<ResourceItemKind>('git_repo');
	let newItemName = $state('');
	let newItemDescription = $state('');
	let newItemUrl = $state('');
	let newItemBranch = $state('main');
	let newItemPackageName = $state('');
	let isCreatingItem = $state(false);

	const resourceQuery = useQuery(
		api.authed.resources.get,
		() => (authContext.currentUser && resourceId ? { resourceId } : 'skip'),
		() => ({ keepPreviousData: true })
	);

	const items = $derived(resourceQuery.data?.items ?? []);

	const createDraft = (item: ResourceItemView): ItemDraft => ({
		kind: item.kind,
		name: item.name,
		description: item.description,
		url: item.url,
		branch: item.branch ?? 'main',
		packageName: item.packageName ?? ''
	});

	$effect(() => {
		const data = resourceQuery.data;

		if (!data || data.resource.id === syncedResourceId) {
			return;
		}

		syncedResourceId = data.resource.id;
		resourceName = data.resource.name;
		resourceSlug = data.resource.slug;
		resourceNotes = data.resource.notes ?? '';
		itemDrafts = Object.fromEntries(
			data.items.map((item: ResourceItemView) => [item.id, createDraft(item)])
		);
		editingItemId = null;
	});

	function resetNewItemForm() {
		newItemKind = 'git_repo';
		newItemName = '';
		newItemDescription = '';
		newItemUrl = '';
		newItemBranch = 'main';
		newItemPackageName = '';
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
		if (!resourceId || isSavingResource) {
			return;
		}

		resourceError = null;
		isSavingResource = true;

		try {
			await convex.mutation(api.authed.resources.update, {
				resourceId,
				name: resourceName,
				slug: resourceSlug,
				notes: resourceNotes.trim() || undefined
			});
		} catch (error) {
			resourceError = error instanceof Error ? error.message : 'Failed to save the resource.';
		} finally {
			isSavingResource = false;
		}
	}

	async function deleteResource() {
		if (!resourceId || isDeletingResource) {
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
			resourceError = error instanceof Error ? error.message : 'Failed to delete the resource.';
		} finally {
			isDeletingResource = false;
		}
	}

	async function createItem() {
		if (!resourceId || isCreatingItem) {
			return;
		}

		itemError = null;
		isCreatingItem = true;

		try {
			await convex.mutation(api.authed.resources.createItem, {
				resourceId,
				kind: newItemKind,
				name: newItemName,
				description: newItemDescription,
				url: newItemUrl.trim() || undefined,
				branch: newItemBranch.trim() || undefined,
				packageName: newItemPackageName.trim() || undefined
			});
			resetNewItemForm();
		} catch (error) {
			itemError = error instanceof Error ? error.message : 'Failed to create the resource item.';
		} finally {
			isCreatingItem = false;
		}
	}

	async function saveItem(itemId: string) {
		const draft = itemDrafts[itemId];

		if (!draft || activeItemMutationId !== null) {
			return;
		}

		itemError = null;
		activeItemMutationId = itemId;

		try {
			await convex.mutation(api.authed.resources.updateItem, {
				itemId: itemId as Id<'resourceItems'>,
				kind: draft.kind,
				name: draft.name,
				description: draft.description,
				url: draft.url.trim() || undefined,
				branch: draft.branch.trim() || undefined,
				packageName: draft.packageName.trim() || undefined
			});
			editingItemId = null;
		} catch (error) {
			itemError = error instanceof Error ? error.message : 'Failed to update the resource item.';
		} finally {
			activeItemMutationId = null;
		}
	}

	async function deleteItem(itemId: string) {
		if (activeItemMutationId !== null) {
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
			itemError = error instanceof Error ? error.message : 'Failed to remove the resource item.';
		} finally {
			activeItemMutationId = null;
		}
	}

	async function moveItem(itemId: string, direction: -1 | 1) {
		if (!resourceId || activeItemMutationId !== null) {
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
			itemError = error instanceof Error ? error.message : 'Failed to reorder the resource items.';
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
				{resourceQuery.data?.resource.name ?? 'Loading...'}
			</h1>
		</header>

		{#if resourceQuery.isLoading}
			<div class="bc-card p-5">
				<p class="bc-muted text-sm">Loading resource...</p>
			</div>
		{:else if resourceQuery.error}
			<div class="bc-card p-5">
				<p class="text-sm text-red-500">{resourceQuery.error.message}</p>
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
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="Svelte"
							/>
						</label>

						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Mention slug</span>
							<div
								class="flex items-center border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm focus-within:border-[hsl(var(--bc-accent))]"
							>
								<span class="mr-1 text-[hsl(var(--bc-fg-muted))]">@</span>
								<input
									bind:value={resourceSlug}
									class="w-full bg-transparent outline-none"
									placeholder="svelte"
								/>
							</div>
						</label>

						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Agent notes</span>
							<textarea
								bind:value={resourceNotes}
								class="bc-scrollbar min-h-28 w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="Optional guidance or framing for the agent."
							></textarea>
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
						class="grid gap-4 border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] p-4 md:grid-cols-2"
					>
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Kind</span>
							<select
								bind:value={newItemKind}
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
							>
								{#each resourceItemKinds as kind (kind)}
									<option value={kind}>{resourceItemKindLabels[kind]}</option>
								{/each}
							</select>
						</label>

						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Name</span>
							<input
								bind:value={newItemName}
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="Core repo"
							/>
						</label>

						<label class="block space-y-1.5 md:col-span-2">
							<span class="text-sm font-medium">Description</span>
							<textarea
								bind:value={newItemDescription}
								class="bc-scrollbar min-h-20 w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder="Explain why this item matters and what the agent should use it for."
							></textarea>
						</label>

						<label class="block space-y-1.5">
							<span class="text-sm font-medium">URL</span>
							<input
								bind:value={newItemUrl}
								class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
								placeholder={newItemKind === 'npm_package'
									? 'Optional if package name is enough'
									: 'https://...'}
							/>
						</label>

						{#if newItemKind === 'git_repo'}
							<label class="block space-y-1.5">
								<span class="text-sm font-medium">Branch</span>
								<input
									bind:value={newItemBranch}
									class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
									placeholder="main"
								/>
							</label>
						{/if}

						{#if newItemKind === 'npm_package'}
							<label class="block space-y-1.5">
								<span class="text-sm font-medium">Package name</span>
								<input
									bind:value={newItemPackageName}
									class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
									placeholder="@sveltejs/kit"
								/>
							</label>
						{/if}

						<div class="flex items-center justify-between gap-3 md:col-span-2">
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
										<div class="grid gap-4 md:grid-cols-2">
											<label class="block space-y-1.5">
												<span class="text-sm font-medium">Kind</span>
												<select
													bind:value={itemDrafts[item.id].kind}
													class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												>
													{#each resourceItemKinds as kind (kind)}
														<option value={kind}>{resourceItemKindLabels[kind]}</option>
													{/each}
												</select>
											</label>

											<label class="block space-y-1.5">
												<span class="text-sm font-medium">Name</span>
												<input
													bind:value={itemDrafts[item.id].name}
													class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												/>
											</label>

											<label class="block space-y-1.5 md:col-span-2">
												<span class="text-sm font-medium">Description</span>
												<textarea
													bind:value={itemDrafts[item.id].description}
													class="bc-scrollbar min-h-20 w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												></textarea>
											</label>

											<label class="block space-y-1.5">
												<span class="text-sm font-medium">URL</span>
												<input
													bind:value={itemDrafts[item.id].url}
													class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
												/>
											</label>

											{#if itemDrafts[item.id].kind === 'git_repo'}
												<label class="block space-y-1.5">
													<span class="text-sm font-medium">Branch</span>
													<input
														bind:value={itemDrafts[item.id].branch}
														class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
														placeholder="main"
													/>
												</label>
											{/if}

											{#if itemDrafts[item.id].kind === 'npm_package'}
												<label class="block space-y-1.5">
													<span class="text-sm font-medium">Package name</span>
													<input
														bind:value={itemDrafts[item.id].packageName}
														class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
													/>
												</label>
											{/if}
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
											<div class="min-w-0 space-y-1">
												<div class="flex flex-wrap items-center gap-2">
													<h3 class="font-semibold">{item.name}</h3>
													<span
														class="bg-[hsl(var(--bc-bg))] px-2 py-0.5 text-xs font-medium text-[hsl(var(--bc-fg-muted))]"
													>
														{resourceItemKindLabels[item.kind]}
													</span>
												</div>
												<p class="bc-muted text-sm leading-6">{item.description}</p>
												{#if item.url}
													<div
														class="flex flex-wrap items-center gap-3 text-xs text-[hsl(var(--bc-fg-muted))]"
													>
														<button
															type="button"
															class="text-left transition hover:text-[hsl(var(--bc-fg))]"
															onclick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
														>
															{item.url}
														</button>
														{#if item.branch}
															<span class="font-medium">branch: {item.branch}</span>
														{/if}
														{#if item.packageName}
															<span class="font-medium">{item.packageName}</span>
														{/if}
													</div>
												{/if}
											</div>

											<div class="flex shrink-0 items-center gap-1">
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

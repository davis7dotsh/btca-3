<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '@btca/convex/api';
	import { BookOpen, Plus } from '@lucide/svelte';
	import { getHumanErrorMessage } from '$lib/errors';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import type { CuratedResource } from '$lib/types/curated-resources';

	let { data }: { data: PageData } = $props();

	const authContext = getAuthContext();
	const convex = useConvexClient();

	let newResourceName = $state('');
	let newResourceNotes = $state('');
	let createError = $state<string | null>(null);
	let curatedError = $state<string | null>(null);
	let isCreating = $state(false);
	let addingCuratedSlug = $state<string | null>(null);

	const resourcesQuery = useQuery(
		api.authed.resources.list,
		() => (authContext.currentUser ? {} : 'skip'),
		() => ({ keepPreviousData: true })
	);
	const existingResourcesBySlug = $derived(
		new Map((resourcesQuery.data ?? []).map((resource) => [resource.slug, resource]))
	);

	const getCuratedDescription = (resource: CuratedResource) =>
		resource.notes ?? resource.specialNotes ?? `Starter resource with ${resource.items.length} items.`;

	const getCuratedSearchPaths = (resource: CuratedResource) => {
		const values = [
			resource.searchPath,
			...(resource.searchPaths ?? []),
			...resource.items.flatMap((item) => [item.searchPath, ...(item.searchPaths ?? [])])
		].filter((value): value is string => Boolean(value));

		return [...new Set(values)];
	};

	const getItemSummary = (resource: CuratedResource) =>
		resource.items.map((item) => item.name).join(' · ');

	async function createResource() {
		const name = newResourceName.trim();

		if (!name || isCreating) {
			return;
		}

		createError = null;
		isCreating = true;

		try {
			const { resourceId } = await convex.mutation(api.authed.resources.create, {
				name,
				notes: newResourceNotes.trim() || undefined
			});

			newResourceName = '';
			newResourceNotes = '';
			await goto(resolve(`/app/resources/${resourceId}`));
		} catch (error) {
			createError = getHumanErrorMessage(error, 'Failed to create the resource.');
		} finally {
			isCreating = false;
		}
	}

	async function quickAddCuratedResource(resource: CuratedResource) {
		if (addingCuratedSlug !== null) {
			return;
		}

		curatedError = null;
		addingCuratedSlug = resource.slug;

		try {
			const existing = existingResourcesBySlug.get(resource.slug);
			if (existing) {
				await goto(resolve(`/app/resources/${existing.id}`));
				return;
			}

			const { resourceId } = await convex.mutation(api.authed.resources.createWithItems, {
				name: resource.name,
				slug: resource.slug,
				notes: resource.notes,
				items: resource.items.map((item) => ({
					kind: item.kind,
					name: item.name,
					description: item.description,
					url: item.url,
					branch: item.branch,
					packageName: item.packageName
				}))
			});

			await goto(resolve(`/app/resources/${resourceId}`));
		} catch (error) {
			curatedError = getHumanErrorMessage(error, `Failed to add ${resource.name}.`);
		} finally {
			addingCuratedSlug = null;
		}
	}
</script>

<div class="bc-scrollbar flex flex-1 flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-5xl space-y-8 p-6">
		<header class="space-y-1">
			<h1 class="bc-title text-2xl">Resources</h1>
			<p class="bc-muted text-sm">Add a starter pack or create your own.</p>
		</header>

		<div class="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
			<section class="bc-card self-start p-5">
				<h2 class="bc-title text-base">New resource</h2>

				<div class="mt-4 space-y-4">
					<label class="block space-y-1.5">
						<span class="text-sm font-medium">Name</span>
						<input
							bind:value={newResourceName}
							class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
							placeholder="Svelte"
						/>
					</label>

					<label class="block space-y-1.5">
						<span class="text-sm font-medium">Agent notes</span>
						<textarea
							bind:value={newResourceNotes}
							class="bc-scrollbar min-h-24 w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
							placeholder="Optional guidance the agent should see whenever this resource is tagged."
						></textarea>
					</label>

					{#if createError}
						<p class="text-sm text-red-500">{createError}</p>
					{/if}

					<button type="button" class="bc-btn w-full" onclick={() => void createResource()}>
						{isCreating ? 'Creating...' : 'Create resource'}
					</button>
				</div>
			</section>

			<section class="space-y-4">
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="bc-title text-base">Your resources</h2>
					<span class="text-sm text-[hsl(var(--bc-fg-muted))]">
						{resourcesQuery.data?.length ?? 0} total
					</span>
				</div>

				{#if resourcesQuery.isLoading}
					<div class="bc-card p-5">
						<p class="bc-muted text-sm">Loading resources...</p>
					</div>
				{:else if resourcesQuery.error}
					<div class="bc-card p-5">
						<p class="text-sm text-red-500">
							{getHumanErrorMessage(resourcesQuery.error, 'Failed to load resources.')}
						</p>
					</div>
				{:else if (resourcesQuery.data?.length ?? 0) === 0}
					<div class="border border-dashed border-[hsl(var(--bc-border))] p-8 text-center">
						<p class="bc-muted text-sm">No resources yet.</p>
					</div>
				{:else}
					<div class="grid gap-2">
						{#each resourcesQuery.data ?? [] as resource (resource.id)}
							<a
								href={resolve(`/app/resources/${resource.id}`)}
								class="group block border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] px-4 py-3 transition hover:border-[hsl(var(--bc-accent))]"
							>
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="flex flex-wrap items-center gap-2">
											<h3 class="font-semibold">{resource.name}</h3>
											<span class="text-xs text-[hsl(var(--bc-fg-muted))]">@{resource.slug}</span>
										</div>
										{#if resource.notes}
											<p class="bc-muted mt-1 line-clamp-1 text-sm">{resource.notes}</p>
										{/if}
									</div>

									<div class="shrink-0 text-right text-xs text-[hsl(var(--bc-fg-muted))]">
										<div>{resource.itemCount} items</div>
									</div>
								</div>
							</a>
						{/each}
					</div>
				{/if}
			</section>
		</div>

		<section class="space-y-4">
			<div class="flex items-baseline justify-between gap-3">
				<div>
					<h2 class="bc-title text-base">Curated starters</h2>
					<p class="bc-muted mt-1 text-sm">Prebuilt resource packs you can add in one click.</p>
				</div>
			</div>

			{#if curatedError}
				<div class="bc-card p-4">
					<p class="text-sm text-red-500">{curatedError}</p>
				</div>
			{/if}

			<div class="grid gap-4 md:grid-cols-2">
				{#each data.curatedResources as resource (resource.slug)}
					{@const existing = existingResourcesBySlug.get(resource.slug)}
					<div class="bc-card space-y-4 p-4">
						<div class="space-y-2">
							<div class="flex flex-wrap items-center gap-2">
								<h3 class="bc-title text-base">{resource.name}</h3>
								<span class="text-xs text-[hsl(var(--bc-fg-muted))]">@{resource.slug}</span>
							</div>
							<p class="bc-muted text-sm">{getCuratedDescription(resource)}</p>
						</div>

						<div class="flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--bc-fg-muted))]">
							<span class="border border-[hsl(var(--bc-border))] px-2 py-1">
								{resource.items.length} items
							</span>
							{#each getCuratedSearchPaths(resource).slice(0, 2) as searchPath (searchPath)}
								<span class="border border-[hsl(var(--bc-border))] px-2 py-1">
									{searchPath}
								</span>
							{/each}
						</div>

						<p class="bc-muted text-sm">{getItemSummary(resource)}</p>

						<div class="flex flex-wrap items-center gap-3">
							{#if existing}
								<a href={resolve(`/app/resources/${existing.id}`)} class="bc-btn">
									<BookOpen size={14} />
									Open
								</a>
							{:else}
								<button
									type="button"
									class="bc-btn bc-btn-primary"
									disabled={addingCuratedSlug !== null}
									onclick={() => void quickAddCuratedResource(resource)}
								>
									<Plus size={14} />
									{addingCuratedSlug === resource.slug ? 'Adding...' : 'Quick add'}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>
	</div>
</div>

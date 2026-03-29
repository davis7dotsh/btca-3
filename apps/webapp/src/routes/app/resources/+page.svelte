<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '@btca/convex/api';
	import { getHumanErrorMessage } from '$lib/errors';
	import { getResourceNameError } from '$lib/resources';
	import { getAuthContext } from '$lib/stores/auth.svelte';

	type ResourceListItem = {
		id: string;
		name: string;
		createdAt: number;
		updatedAt: number;
		itemCount: number;
	};

	type QueryState<T> = {
		data: T | undefined;
		isLoading: boolean;
		error: unknown;
	};

	const authContext = getAuthContext();
	const convex = browser ? useConvexClient() : null;

	let newResourceName = $state('');
	let createError = $state<string | null>(null);
	let isCreating = $state(false);

	const resourcesQuery: QueryState<ResourceListItem[]> = browser
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

	async function createResource() {
		if (isCreating || !convex) {
			return;
		}

		createError = getResourceNameError(newResourceName);

		if (createError) {
			return;
		}

		isCreating = true;

		try {
			const { resourceId } = await convex.mutation(api.authed.resources.create, {
				name: newResourceName
			});

			newResourceName = '';
			await goto(resolve(`/app/resources/${resourceId}`));
		} catch (error) {
			createError = getHumanErrorMessage(error, 'Failed to create the resource.');
		} finally {
			isCreating = false;
		}
	}
</script>

<div class="bc-scrollbar flex flex-1 flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-5xl space-y-8 p-6">
		<header class="space-y-1">
			<h1 class="bc-title text-2xl">Resources</h1>
			<p class="bc-muted text-sm">Create short `@mention` names and attach URLs the agent can use.</p>
		</header>

		<div class="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
			<section class="bc-card self-start p-5">
				<h2 class="bc-title text-base">New resource</h2>

				<form
					class="mt-4 space-y-4"
					onsubmit={(event) => {
						event.preventDefault();
						void createResource();
					}}
				>
					<label class="block space-y-1.5">
						<span class="text-sm font-medium">Name</span>
						<input
							bind:value={newResourceName}
							oninput={() => (createError = null)}
							class="w-full border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm transition outline-none focus:border-[hsl(var(--bc-accent))]"
							placeholder="svelte"
						/>
						<p class="bc-muted text-xs">Used directly in chat as `@name`.</p>
					</label>

					{#if createError}
						<p class="text-sm text-red-500">{createError}</p>
					{/if}

					<button type="submit" class="bc-btn w-full" disabled={isCreating}>
						{isCreating ? 'Creating...' : 'Create resource'}
					</button>
				</form>
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
											<span class="text-xs text-[hsl(var(--bc-fg-muted))]">@{resource.name}</span>
										</div>
									</div>

									<div class="shrink-0 text-right text-xs text-[hsl(var(--bc-fg-muted))]">
										<div>{resource.itemCount} links</div>
									</div>
								</div>
							</a>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</div>
</div>

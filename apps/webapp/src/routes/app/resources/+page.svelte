<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '@btca/convex/api';
	import { getAuthContext } from '$lib/stores/auth.svelte';

	const authContext = getAuthContext();
	const convex = useConvexClient();

	let newResourceName = $state('');
	let newResourceNotes = $state('');
	let createError = $state<string | null>(null);
	let isCreating = $state(false);

	const resourcesQuery = useQuery(
		api.authed.resources.list,
		() => (authContext.currentUser ? {} : 'skip'),
		() => ({ keepPreviousData: true })
	);

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
			createError = error instanceof Error ? error.message : 'Failed to create the resource.';
		} finally {
			isCreating = false;
		}
	}
</script>

<div class="bc-scrollbar flex flex-1 flex-col overflow-y-auto">
	<div class="bc-reveal mx-auto w-full max-w-5xl space-y-6 p-6">
		<header class="space-y-2">
			<p class="bc-kicker">
				<span class="bc-kickerDot"></span>
				Resources
			</p>
			<h1 class="bc-title text-2xl">Resources</h1>
			<p class="bc-muted max-w-2xl text-sm">
				Curate what the agent sees when you mention <code class="text-[hsl(var(--bc-fg))]"
					>@resources</code
				> in chat.
			</p>
		</header>

		<div class="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
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
						<p class="text-sm text-red-500">{resourcesQuery.error.message}</p>
					</div>
				{:else if (resourcesQuery.data?.length ?? 0) === 0}
					<div class="border border-dashed border-[hsl(var(--bc-border))] p-8 text-center">
						<p class="bc-muted text-sm">No resources yet.</p>
					</div>
				{:else}
					<div class="space-y-2">
						{#each resourcesQuery.data ?? [] as resource (resource.id)}
							<a
								href={resolve(`/app/resources/${resource.id}`)}
								class="group block border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface))] p-4 transition hover:border-[hsl(var(--bc-accent))]"
							>
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0 space-y-1">
										<div class="flex flex-wrap items-center gap-2">
											<h3 class="font-semibold">{resource.name}</h3>
											<span
												class="bg-[hsl(var(--bc-bg))] px-2 py-0.5 text-xs font-medium text-[hsl(var(--bc-fg-muted))]"
											>
												@{resource.slug}
											</span>
										</div>
										{#if resource.notes}
											<p class="bc-muted line-clamp-2 text-sm leading-6">{resource.notes}</p>
										{/if}
									</div>

									<div class="shrink-0 text-right text-xs text-[hsl(var(--bc-fg-muted))]">
										<div class="font-medium">{resource.itemCount} items</div>
										<div class="mt-0.5">{new Date(resource.updatedAt).toLocaleDateString()}</div>
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

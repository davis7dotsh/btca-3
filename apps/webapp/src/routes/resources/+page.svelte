<script lang="ts">
	import CopyButton from '$lib/components/CopyButton.svelte';
	import { GLOBAL_RESOURCES, type GlobalResource } from '$lib/marketing/resources';
	import { ExternalLink, Search } from '@lucide/svelte';

	let query = $state('');

	const getSearchText = (resource: GlobalResource) =>
		[
			resource.name,
			resource.displayName,
			resource.url,
			resource.branch,
			resource.searchPath,
			...(resource.searchPaths ?? []),
			resource.specialNotes
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase();

	const filteredResources = $derived.by(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return GLOBAL_RESOURCES;
		return GLOBAL_RESOURCES.filter((resource) => getSearchText(resource).includes(normalized));
	});

	const getSearchPath = (resource: GlobalResource) =>
		resource.searchPath ?? resource.searchPaths?.join(', ');

	const getConfigSnippet = (resource: GlobalResource) =>
		JSON.stringify(
			{
				type: resource.type,
				name: resource.name,
				url: resource.url,
				branch: resource.branch,
				...(resource.searchPath ? { searchPath: resource.searchPath } : {}),
				...(resource.searchPaths ? { searchPaths: resource.searchPaths } : {}),
				...(resource.specialNotes ? { specialNotes: resource.specialNotes } : {})
			},
			null,
			2
		);

	const getCliCommand = (resource: GlobalResource) => {
		const searchPath = resource.searchPath ?? resource.searchPaths?.[0];
		const parts = [
			'btca',
			'add',
			resource.url,
			'--name',
			resource.name,
			'--branch',
			resource.branch
		];
		if (searchPath) {
			parts.push('--search-path', searchPath);
		}
		return parts.join(' ');
	};

	const resourceDescriptions: Record<string, string> = {
		runed:
			'Utilities and patterns for Svelte projects. Helpful when you need quick answers from the Runed codebase.',
		convexWorkpools:
			'Convex work pool component docs and code. Useful for background job, queue, and retry questions.',
		daytona:
			'The Daytona platform repo. Good for sandbox, workspace, and example-based exploration.',
		svelte:
			'Svelte docs content. Great for searching framework guides and reference docs with btca.',
		svelteKit:
			'SvelteKit documentation. Use it when you want answers grounded in the official docs directory.',
		tailwind:
			'Tailwind CSS docs. Handy for looking up utility behavior, config, and framework guidance.',
		hono: 'Hono website docs. Useful for routing, middleware, and server examples.',
		zod: 'Zod docs content. Good for schema, validation, and type inference questions.',
		solidJs: 'Solid docs routes and content. Helpful for framework APIs, patterns, and examples.',
		vite: 'Vite docs. Useful for config, plugin, and build-tool questions.',
		opencode:
			'OpenCode source. Good for understanding tool behavior, MCP setup, and implementation details.',
		clerk:
			'Clerk JavaScript SDK source. Useful for auth flows, components, and integration questions.',
		convexJs:
			'Convex JavaScript client source. Helpful for API behavior and client-side integration details.',
		convexDocs:
			'Official Convex documentation. Great for queries, mutations, actions, schema, and deployment guidance.'
	};

	const getResourceDescription = (resource: GlobalResource) =>
		resourceDescriptions[resource.name] ??
		resource.specialNotes ??
		`Add ${resource.displayName} when you want btca grounded in that repo.`;
</script>

<svelte:head>
	<title>btca | Resources</title>
	<meta
		name="description"
		content="Starter repos you can add to btca to test grounded repo search quickly."
	/>
</svelte:head>

<section class="flex flex-col gap-14">
	<header class="flex flex-col gap-5">
		<div class="bc-kicker">
			<span class="bc-kickerDot"></span>
			<span>Starter repos</span>
		</div>

		<h1 class="bc-h1 text-balance text-5xl sm:text-6xl">Popular repos you can add to btca</h1>
		<p class="bc-prose max-w-2xl text-pretty text-base sm:text-lg">
			Start with these popular repos, then add your own codebases and docs.
		</p>
		<div class="flex flex-wrap gap-3">
			<a href="https://docs.btca.dev" class="bc-chip" target="_blank" rel="noreferrer">Docs</a>
		</div>
	</header>

	<div class="bc-card bc-ring flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
		<div class="flex items-center gap-2 text-sm font-semibold">
			<Search size={16} />
			Find a starter repo
		</div>
		<input
			type="text"
			class="bc-input flex-1"
			placeholder="Search by name, URL, or notes"
			bind:value={query}
		/>
	</div>

	<section class="bc-card bc-ring p-6">
		<p class="text-sm bc-prose">
			Use these starter repos to test btca quickly, or add any git repo you want. These are
			examples, not a fixed catalog. btca works best when you add the repos you actually use.
		</p>
	</section>

	<div class="grid gap-4 md:grid-cols-2">
		{#if filteredResources.length === 0}
			<div class="bc-card p-6 text-sm bc-prose">No matches. Try a different search.</div>
		{:else}
			{#each filteredResources as resource (resource.name)}
				<div class="bc-card bc-ring bc-cardHover flex flex-col gap-4 p-5">
					<div class="flex items-start gap-4">
						<div
							class="bc-badge bc-badgeAccent mt-0.5 min-w-[3rem] justify-center text-xs uppercase tracking-[0.14em]"
						>
							{resource.logoKey ?? 'repo'}
						</div>
						<div class="flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-base font-semibold">@{resource.name}</span>
								<span class="bc-badge">{resource.displayName}</span>
							</div>
							<p class="mt-2 text-sm bc-prose">{getResourceDescription(resource)}</p>
							<p class="bc-muted mt-1 text-xs break-all">{resource.url}</p>
							{#if getSearchPath(resource)}
								<p class="bc-muted mt-2 text-xs">Search path: {getSearchPath(resource)}</p>
							{/if}
						</div>
					</div>

					<div class="flex flex-wrap items-center gap-3 text-xs">
						<div class="flex items-center gap-2">
							<CopyButton text={getConfigSnippet(resource)} label="Copy config snippet" />
							<span>Copy config</span>
						</div>
						<div class="flex items-center gap-2">
							<CopyButton text={getCliCommand(resource)} label="Copy CLI command" />
							<span>Copy CLI command</span>
						</div>
						<a
							href={resource.url}
							target="_blank"
							rel="noreferrer"
							class="bc-chip flex items-center gap-2 px-3 py-1.5 text-xs"
						>
							<ExternalLink size={14} />
							Open repo
						</a>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</section>

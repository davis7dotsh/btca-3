<script lang="ts">
	import cliShowcase from '$lib/assets/cli-showcase.png';
	import mcpShowcase from '$lib/assets/mcp-showcase.png';
	import webShowcase from '$lib/assets/web-showcase.png';
	import { X } from '@lucide/svelte';

	type ShowcaseCard = {
		label: string;
		eyebrow: string;
		title: string;
		description: string;
		image: string;
		alt: string;
	};

	const showcaseCards: ShowcaseCard[] = [
		{
			label: 'CLI',
			eyebrow: 'local',
			title: 'Ask questions about local repos in your terminal.',
			description:
				'Keep code on your machine. Add repos or directories. Get grounded answers fast.',
			image: cliShowcase,
			alt: 'btca CLI showcase'
		},
		{
			label: 'Web app',
			eyebrow: 'cloud',
			title: 'Save threads, organize projects, and search code in the cloud.',
			description: 'Good for ongoing research, team context, and work you want to revisit.',
			image: webShowcase,
			alt: 'btca web app showcase'
		},
		{
			label: 'MCP',
			eyebrow: 'agents',
			title: 'Give Cursor, Claude Code, Codex, and other tools access to the right repo context.',
			description: 'Use btca as the codebase lookup layer for your agents.',
			image: mcpShowcase,
			alt: 'btca MCP showcase'
		}
	];

	let activePreview = $state<ShowcaseCard | null>(null);

	const openPreview = (card: ShowcaseCard) => {
		activePreview = card;
	};

	const closePreview = () => {
		activePreview = null;
	};

	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			closePreview();
		}
	};
</script>

<svelte:head>
	<title>btca</title>
	<meta
		name="description"
		content="Ask questions about any codebase and get answers grounded in the repo with btca."
	/>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<section class="flex flex-col gap-14">
	<section class="flex flex-col gap-5">
		<h1 class="bc-h1 text-balance text-5xl sm:text-6xl lg:text-7xl bc-reveal" style="--delay: 90ms">
			Ask the repo,
			<span class="text-[hsl(var(--bc-accent))]">not the internet.</span>
		</h1>

		<p class="bc-prose max-w-3xl text-pretty text-base sm:text-lg bc-reveal" style="--delay: 160ms">
			Search source files, docs, and config with the CLI, web app, or MCP. Get answers tied to the
			codebase instead of generic model guesses.
		</p>

		<p
			class="max-w-2xl text-sm font-medium text-[hsl(var(--bc-accent))] bc-reveal"
			style="--delay: 195ms"
		>
			Your AI can already write code. btca helps it read the codebase first.
		</p>

		<div class="flex flex-col gap-3 sm:flex-row sm:items-center bc-reveal" style="--delay: 230ms">
			<a href="/app" class="bc-chip bc-btnPrimary justify-center">Try the web app</a>
			<a
				href="https://docs.btca.dev/guides/quickstart"
				class="bc-chip justify-center"
				target="_blank"
				rel="noreferrer"
			>
				Install the CLI
			</a>
			<a href="/pricing" class="bc-chip justify-center">View pricing</a>
		</div>
	</section>

	<section class="grid items-stretch gap-5 lg:grid-cols-3">
		{#each showcaseCards as card}
			<button
				type="button"
				class="bc-card bc-ring bc-cardHover flex h-full cursor-pointer flex-col overflow-hidden text-left transition-transform hover:-translate-y-0.5"
				onclick={() => openPreview(card)}
				aria-label={`Open ${card.label} preview`}
			>
				<div class="flex items-center justify-between gap-4 px-5 py-4">
					<div class="bc-badge bc-badgeAccent">
						<span class="bc-kickerDot"></span>
						<span>{card.label}</span>
					</div>
					<div class="text-sm font-medium bc-muted">
						{card.eyebrow}
					</div>
				</div>

				<div class="flex flex-1 flex-col px-5 pb-5">
					<h2 class="text-lg font-semibold">{card.title}</h2>
					<p class="bc-prose mt-2 text-sm">{card.description}</p>
					<div class="mt-auto pt-4">
						<img
							src={card.image}
							alt={card.alt}
							class="w-full rounded-lg border border-[hsl(var(--bc-border))]"
							loading="lazy"
						/>
					</div>
				</div>
			</button>
		{/each}
	</section>

	<section class="bc-card bc-ring p-6">
		<div class="max-w-3xl">
			<div class="text-sm font-semibold">Why use btca?</div>
			<p class="mt-2 text-sm bc-prose">
				Generic AI answers are often based on priors, stale docs, or incomplete context. btca
				narrows the model to the repos and resources you choose, so answers are grounded in the
				codebase you actually care about.
			</p>
		</div>
	</section>

	<section class="bc-card bc-ring p-6">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<div class="text-sm font-semibold">Pick the workflow you want:</div>
				<p class="mt-1 text-sm bc-prose">
					CLI for local repo search, web app for saved threads and cloud projects, docs for setup,
					pricing for plan details, and resources for starter repos.
				</p>
			</div>
			<div class="flex flex-wrap gap-3">
				<a href="/cli" class="bc-chip">CLI</a>
				<a href="/web" class="bc-chip">Web app</a>
				<a href="https://docs.btca.dev" class="bc-chip" target="_blank" rel="noreferrer">Docs</a>
				<a href="/pricing" class="bc-chip">Pricing</a>
				<a href="/resources" class="bc-chip">Resources</a>
				<a
					href="https://docs.btca.dev/guides/configuration"
					class="bc-chip"
					target="_blank"
					rel="noreferrer"
				>
					Configuration
				</a>
			</div>
		</div>
	</section>
</section>

{#if activePreview}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(0_0%_0%/0.86)] p-4 backdrop-blur-sm sm:p-8"
		role="dialog"
		aria-modal="true"
		aria-label={`${activePreview.label} preview`}
		tabindex="-1"
	>
		<button type="button" class="absolute inset-0" onclick={closePreview} aria-label="Close preview"
		></button>

		<button
			type="button"
			class="bc-chip absolute top-4 right-4 z-20 sm:top-6 sm:right-6"
			onclick={closePreview}
			aria-label="Close preview"
		>
			<X size={18} />
		</button>

		<div class="relative z-10 flex max-h-full w-full max-w-7xl flex-col gap-4">
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="bc-badge bc-badgeAccent">
						<span class="bc-kickerDot"></span>
						<span>{activePreview.label}</span>
					</div>
					<p class="bc-prose mt-3 max-w-3xl text-sm">{activePreview.title}</p>
				</div>
				<div class="hidden text-sm font-medium bc-muted sm:block">
					{activePreview.eyebrow}
				</div>
			</div>

			<div class="min-h-0 overflow-auto">
				<img
					src={activePreview.image}
					alt={activePreview.alt}
					class="mx-auto max-h-[78vh] w-full rounded-xl object-contain shadow-[0_24px_80px_hsl(0_0%_0%/0.55)]"
				/>
			</div>
		</div>
	</div>
{/if}

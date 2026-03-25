<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>pi land</title>
	<meta name="description" content="AI agent workspace with chat, resources, and MCP." />
</svelte:head>

<div class="relative min-h-screen overflow-hidden bg-[hsl(var(--bc-bg))] text-[hsl(var(--bc-fg))]">
	<div aria-hidden="true" class="bc-appBg absolute inset-0"></div>
	<div
		aria-hidden="true"
		class="absolute inset-x-0 top-0 h-[26rem] bg-[radial-gradient(circle_at_top,rgba(71,131,235,0.16),transparent_65%)]"
	></div>

	<main class="relative mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">
		<section class="bc-card bc-reveal w-full max-w-2xl p-8 md:p-12">
			<div class="space-y-6">
				<div class="bc-logoMark">PL</div>
				<div class="space-y-4">
					<h1 class="bc-h1 max-w-3xl text-4xl sm:text-5xl">pi land</h1>
					<p class="bc-prose text-base sm:text-lg">
						Your agent workspace. Chat, curate resources, and connect MCP clients &mdash; all in one
						place.
					</p>
				</div>
				<a href={resolve('/app')} class="bc-btn bc-btn-primary"> Open the app </a>
			</div>
		</section>
	</main>
</div>

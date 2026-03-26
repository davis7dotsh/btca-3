<script lang="ts">
	import cliShowcase from '$lib/assets/cli-showcase.png';
</script>

<svelte:head>
	<title>btca | CLI</title>
	<meta
		name="description"
		content="Ask questions about any codebase from your terminal with the btca CLI."
	/>
</svelte:head>

<section class="flex flex-col gap-14">
	<header class="flex flex-col gap-5">
		<div class="bc-kicker">
			<span class="bc-kickerDot"></span>
			<span>CLI</span>
		</div>

		<h1 class="bc-h1 text-balance text-5xl sm:text-6xl">
			Ask questions about any codebase from your terminal.
		</h1>
		<p class="bc-prose max-w-2xl text-pretty text-base sm:text-lg">
			Search repos and local directories from the CLI and get answers grounded in source files,
			docs, and config, no browser required.
		</p>

		<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
			<a
				href="https://docs.btca.dev/guides/quickstart"
				class="bc-chip bc-btnPrimary justify-center"
				target="_blank"
				rel="noreferrer">Install btca</a
			>
			<a
				href="https://docs.btca.dev/guides/cli-reference"
				class="bc-chip justify-center"
				target="_blank"
				rel="noreferrer">Read CLI docs</a
			>
		</div>
	</header>

	<section>
		<div class="bc-kicker">
			<span class="bc-kickerDot"></span>
			<span>In action</span>
		</div>
		<p class="mt-2 max-w-2xl text-sm bc-prose">
			See what a grounded repo query looks like in the terminal.
		</p>

		<div class="mt-4">
			<div class="bc-card bc-ring p-5">
				<div class="text-sm font-medium bc-muted">Terminal</div>
				<img
					src={cliShowcase}
					alt="btca CLI in action"
					class="mt-3 w-full rounded-lg border border-[hsl(var(--bc-border))]"
					loading="lazy"
				/>
			</div>
		</div>

		<ul class="mt-4 flex flex-col gap-2 text-sm bc-prose">
			<li class="flex items-start gap-2">
				<span class="bc-kickerDot mt-1.5 shrink-0"></span>
				<span
					><strong>Ask a repo question with one command</strong> -
					<code class="bc-inlineCode">btca ask -r svelte -q "How do runes work?"</code></span
				>
			</li>
			<li class="flex items-start gap-2">
				<span class="bc-kickerDot mt-1.5 shrink-0"></span>
				<span><strong>Use the TUI for multi-turn debugging and exploration</strong></span>
			</li>
			<li class="flex items-start gap-2">
				<span class="bc-kickerDot mt-1.5 shrink-0"></span>
				<span><strong>Index any git repo or local directory</strong></span>
			</li>
			<li class="flex items-start gap-2">
				<span class="bc-kickerDot mt-1.5 shrink-0"></span>
				<span><strong>Use your own model provider</strong> - 7+ providers supported out of the box</span>
			</li>
			<li class="flex items-start gap-2">
				<span class="bc-kickerDot mt-1.5 shrink-0"></span>
				<span><strong>Expose a local MCP server for coding tools</strong></span>
			</li>
			<li class="flex items-start gap-2">
				<span class="bc-kickerDot mt-1.5 shrink-0"></span>
				<span><strong>Keep private code on your machine</strong></span>
			</li>
		</ul>
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
				<div class="text-sm font-semibold">Ready to try it?</div>
				<p class="mt-1 text-sm bc-prose">
					Install btca, add a repo, and ask your first grounded question in minutes.
				</p>
			</div>
			<div class="flex flex-wrap gap-3">
				<a
					href="https://docs.btca.dev/guides/quickstart"
					class="bc-chip bc-btnPrimary"
					target="_blank"
					rel="noreferrer">Install btca</a
				>
				<a
					href="https://docs.btca.dev/guides/cli-reference"
					class="bc-chip"
					target="_blank"
					rel="noreferrer">Read CLI docs</a
				>
			</div>
		</div>
	</section>
</section>

<script lang="ts">
	import { runBoxPrototype } from '$lib/remote/box-test.remote';

	type BoxPrototypeResult = Awaited<ReturnType<typeof runBoxPrototype>>;

	const createThreadId = () => crypto.randomUUID();

	let threadId = $state(createThreadId());
	let boxId = $state('');
	let prompt = $state(
		[
			'Use the configured Exa MCP tools for web research.',
			'Search for the latest Upstash Box Codex docs and summarize how an agent should use the Exa MCP tools inside this box.',
			'Show the exact MCP tools and commands you used.'
		].join(' ')
	);
	let status = $state<'idle' | 'running'>('idle');
	let errorMessage = $state('');
	let lastRun = $state.raw<BoxPrototypeResult | null>(null);

	async function runPrototype() {
		status = 'running';
		errorMessage = '';

		try {
			const result = await runBoxPrototype({
				threadId,
				boxId: boxId || undefined,
				prompt
			});

			lastRun = result;
			boxId = result.boxId;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			status = 'idle';
		}
	}

	function resetThread() {
		threadId = createThreadId();
		boxId = '';
		lastRun = null;
		errorMessage = '';
	}
</script>

<svelte:head>
	<title>Box Test</title>
</svelte:head>

<div class="min-h-0 flex-1 overflow-y-auto bg-[hsl(var(--bc-bg))]">
	<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
		<section
			class="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_20px_80px_rgba(0,0,0,0.25)] backdrop-blur"
		>
			<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
				<div class="space-y-2">
					<p class="text-xs tracking-[0.3em] text-[hsl(var(--bc-fg-muted))] uppercase">
						Temporary Prototype
					</p>
					<h1 class="text-3xl font-semibold text-[hsl(var(--bc-fg))]">Upstash Box Test Bench</h1>
					<p class="max-w-2xl text-sm leading-6 text-[hsl(var(--bc-fg-muted))]">
						This page triggers the new Box-backed remote command and leaves the detailed run
						telemetry in the backend logs. Reuse the same thread and box IDs to keep poking the same
						durable box.
					</p>
				</div>

				<div
					class="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-[hsl(var(--bc-fg-muted))]"
				>
					<p>Backend logs are the source of truth for this prototype.</p>
				</div>
			</div>
		</section>

		<section class="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
			<div class="space-y-4 rounded-3xl border border-white/10 bg-black/20 p-6">
				<div class="grid gap-4 md:grid-cols-2">
					<label class="space-y-2">
						<span class="text-xs tracking-[0.24em] text-[hsl(var(--bc-fg-muted))] uppercase">
							Thread ID
						</span>
						<input
							class="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-[hsl(var(--bc-fg))] transition outline-none focus:border-cyan-400/60"
							bind:value={threadId}
						/>
					</label>

					<label class="space-y-2">
						<span class="text-xs tracking-[0.24em] text-[hsl(var(--bc-fg-muted))] uppercase">
							Box ID
						</span>
						<input
							class="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-[hsl(var(--bc-fg))] transition outline-none focus:border-cyan-400/60"
							bind:value={boxId}
							placeholder="Created after the first run"
						/>
					</label>
				</div>

				<label class="space-y-2">
					<span class="text-xs tracking-[0.24em] text-[hsl(var(--bc-fg-muted))] uppercase">
						Prompt
					</span>
					<textarea
						class="min-h-56 w-full rounded-3xl border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-[hsl(var(--bc-fg))] transition outline-none focus:border-cyan-400/60"
						bind:value={prompt}
					></textarea>
				</label>

				<div class="flex flex-wrap gap-3">
					<button
						class="rounded-full bg-cyan-400 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
						disabled={status === 'running' || prompt.trim().length === 0}
						onclick={() => void runPrototype()}
					>
						{status === 'running' ? 'Running...' : 'Run Box Prototype'}
					</button>

					<button
						class="rounded-full border border-white/10 px-5 py-3 text-sm text-[hsl(var(--bc-fg))] transition hover:border-white/30 hover:bg-white/5"
						disabled={status === 'running'}
						onclick={resetThread}
					>
						New Thread
					</button>
				</div>

				{#if errorMessage}
					<div
						class="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
					>
						{errorMessage}
					</div>
				{/if}
			</div>

			<div class="space-y-4">
				<div class="rounded-3xl border border-white/10 bg-white/5 p-5">
					<p class="text-xs tracking-[0.24em] text-[hsl(var(--bc-fg-muted))] uppercase">State</p>
					<div class="mt-4 space-y-3 text-sm text-[hsl(var(--bc-fg))]">
						<div class="rounded-2xl bg-black/20 px-4 py-3">
							<div class="text-[hsl(var(--bc-fg-muted))]">Status</div>
							<div class="mt-1 font-medium capitalize">{status}</div>
						</div>
						<div class="rounded-2xl bg-black/20 px-4 py-3">
							<div class="text-[hsl(var(--bc-fg-muted))]">Current box</div>
							<div class="mt-1 font-mono text-xs break-all">{boxId || 'None yet'}</div>
						</div>
						<div class="rounded-2xl bg-black/20 px-4 py-3">
							<div class="text-[hsl(var(--bc-fg-muted))]">Thread</div>
							<div class="mt-1 font-mono text-xs break-all">{threadId}</div>
						</div>
					</div>
				</div>

				<div class="rounded-3xl border border-white/10 bg-black/20 p-5">
					<p class="text-xs tracking-[0.24em] text-[hsl(var(--bc-fg-muted))] uppercase">Last Run</p>

					{#if lastRun}
						<div class="mt-4 space-y-3 text-sm text-[hsl(var(--bc-fg))]">
							<div class="rounded-2xl bg-white/5 px-4 py-3">
								<div class="text-[hsl(var(--bc-fg-muted))]">Model</div>
								<div class="mt-1 font-mono text-xs">{lastRun.model}</div>
							</div>
							<div class="rounded-2xl bg-white/5 px-4 py-3">
								<div class="text-[hsl(var(--bc-fg-muted))]">Run ID</div>
								<div class="mt-1 font-mono text-xs break-all">{lastRun.runId}</div>
							</div>
							<div class="rounded-2xl bg-white/5 px-4 py-3">
								<div class="text-[hsl(var(--bc-fg-muted))]">Created box this run</div>
								<div class="mt-1">{lastRun.createdBox ? 'Yes' : 'No'}</div>
							</div>
						</div>
					{:else}
						<p class="mt-4 text-sm text-[hsl(var(--bc-fg-muted))]">
							No run yet. Fire one off and then inspect the backend logs.
						</p>
					{/if}
				</div>
			</div>
		</section>

		<section class="rounded-3xl border border-white/10 bg-black/30 p-6">
			<div class="flex items-center justify-between gap-4">
				<div>
					<p class="text-xs tracking-[0.24em] text-[hsl(var(--bc-fg-muted))] uppercase">
						Assistant Output
					</p>
					<p class="mt-2 text-sm text-[hsl(var(--bc-fg-muted))]">
						This is just the final returned text. Tool traces and chunk-level details are logged on
						the server.
					</p>
				</div>
			</div>

			<pre
				class="mt-5 overflow-x-auto rounded-3xl border border-white/10 bg-slate-950/70 p-5 text-sm leading-6 text-slate-100">{lastRun?.output ||
					'No output yet.'}</pre>
		</section>
	</div>
</div>

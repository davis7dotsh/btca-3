<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	type Snippet = {
		id: string;
		title: string;
		path: string;
		code: string;
		note?: string;
	};

	const publicOrigin = $derived(page.url.origin);
	const mcpUrl = $derived(new URL(resolve('/api/mcp'), publicOrigin).href);
	const protectedResourceUrl = $derived(
		new URL(resolve('/.well-known/oauth-protected-resource'), publicOrigin).href
	);
	const authorizationServerUrl = $derived(
		new URL(resolve('/.well-known/oauth-authorization-server'), publicOrigin).href
	);

	let copiedSnippetId = $state<string | null>(null);

	const snippets = $derived.by<Snippet[]>(() => [
		{
			id: 'codex-config',
			title: 'OpenAI Codex',
			path: '~/.codex/config.toml',
			code: `[mcp_servers.piLand]\nurl = "${mcpUrl}"`
		},
		{
			id: 'codex-cli',
			title: 'Codex CLI',
			path: 'Terminal',
			code: `codex mcp add piLand --url ${mcpUrl}`,
			note: 'Verify with `codex mcp list`.'
		},
		{
			id: 'claude-code',
			title: 'Claude Code',
			path: '.mcp.json or ~/.claude.json',
			code: JSON.stringify(
				{
					mcpServers: {
						piLand: {
							type: 'http',
							url: mcpUrl
						}
					}
				},
				null,
				2
			),
			note: `CLI alternative: claude mcp add --transport http piLand ${mcpUrl}`
		},
		{
			id: 'opencode',
			title: 'OpenCode',
			path: 'opencode.json',
			code: JSON.stringify(
				{
					$schema: 'https://opencode.ai/config.json',
					mcp: {
						piLand: {
							type: 'remote',
							url: mcpUrl,
							enabled: true
						}
					}
				},
				null,
				2
			),
			note: 'If auth does not start automatically, run `opencode mcp auth piLand`.'
		},
		{
			id: 'cursor',
			title: 'Cursor',
			path: '.cursor/mcp.json or ~/.cursor/mcp.json',
			code: JSON.stringify(
				{
					mcpServers: {
						piLand: {
							url: mcpUrl
						}
					}
				},
				null,
				2
			)
		}
	]);

	const endpointCards = $derived([
		{
			title: 'MCP Endpoint',
			value: mcpUrl
		},
		{
			title: 'Protected Resource Metadata',
			value: protectedResourceUrl
		},
		{
			title: 'Authorization Server Metadata',
			value: authorizationServerUrl
		}
	]);

	async function copySnippet(snippetId: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedSnippetId = snippetId;
			window.setTimeout(() => {
				if (copiedSnippetId === snippetId) {
					copiedSnippetId = null;
				}
			}, 1500);
		} catch (error) {
			console.error('Failed to copy MCP snippet', error);
		}
	}

	function openMcpDashboard() {
		void goto(resolve('/app/mcp'), {
			noScroll: true,
			keepFocus: true
		});
	}
</script>

<svelte:head>
	<title>btca web | MCP Getting Started</title>
</svelte:head>

<div class="bc-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto bg-[hsl(var(--bc-bg))]">
	<section class="bc-reveal border-b border-[hsl(var(--bc-border))] px-6 py-6">
		<div class="flex flex-wrap items-start justify-between gap-4">
			<div class="space-y-2">
				<p class="bc-kicker">
					<span class="bc-kickerDot"></span>
					MCP
				</p>
				<h1 class="bc-title text-2xl">Connect a client</h1>
			</div>

			<button type="button" class="bc-btn shrink-0" onclick={openMcpDashboard}>
				Back to threads
			</button>
		</div>

		<div class="mt-6 grid gap-3 md:grid-cols-3">
			{#each endpointCards as card (card.title)}
				<div class="bc-card p-4">
					<p
						class="text-sm font-semibold text-[hsl(var(--bc-fg-muted))]"
					>
						{card.title}
					</p>
					<p class="mt-3 font-mono text-xs leading-6 break-all text-[hsl(var(--bc-fg))]">
						{card.value}
					</p>
				</div>
			{/each}
		</div>
	</section>

	<section class="px-6 py-6">
		<div class="grid gap-5">
			{#each snippets as snippet (snippet.id)}
				<article class="bc-card p-5">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="flex flex-wrap items-center gap-2">
							<h2 class="text-base font-semibold text-[hsl(var(--bc-fg))]">{snippet.title}</h2>
							<span
								class="border border-[hsl(var(--bc-border))] px-2 py-0.5 font-mono text-[10px] text-[hsl(var(--bc-fg-muted))]"
							>
								{snippet.path}
							</span>
						</div>

						<button
							type="button"
							class="bc-btn shrink-0"
							onclick={() => copySnippet(snippet.id, snippet.code)}
						>
							{copiedSnippetId === snippet.id ? 'Copied' : 'Copy'}
						</button>
					</div>

					{#if snippet.note}
						<p class="mt-2 text-xs text-[hsl(var(--bc-fg-muted))]">{snippet.note}</p>
					{/if}

					<pre
						class="mt-3 overflow-x-auto border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-surface-2))] p-4 font-mono text-xs leading-6 text-[hsl(var(--bc-fg))]"><code
							>{snippet.code}</code
						></pre>
				</article>
			{/each}
		</div>
	</section>
</div>

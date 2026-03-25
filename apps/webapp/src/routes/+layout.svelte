<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import ogImage from '$lib/assets/og.png';
	import { Bot, GitBranch, Menu, Moon, Sun, X } from '@lucide/svelte';
	import { page } from '$app/state';
	import { theme } from '$lib/stores/theme.svelte';

	let { children } = $props();
	let mobileNavOpen = $state(false);

	const isAppRoute = $derived(page.url.pathname.startsWith('/app'));
	const pathname = $derived(page.url.pathname);

	const isActive = (href: string) =>
		pathname === href || (href !== '/' && pathname.startsWith(href));

	const toggleNav = () => {
		mobileNavOpen = !mobileNavOpen;
	};

	$effect(() => {
		if (page.url.pathname && mobileNavOpen) {
			mobileNavOpen = false;
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>btca</title>
	<meta
		name="description"
		content="Ask questions about any codebase and get answers grounded in the repo with btca."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="btca" />
	<meta
		property="og:description"
		content="Ask questions about any codebase and get answers grounded in the repo with btca."
	/>
	<meta property="og:image" content={ogImage} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="btca" />
	<meta
		name="twitter:description"
		content="Ask questions about any codebase and get answers grounded in the repo with btca."
	/>
	<meta name="twitter:image" content={ogImage} />
</svelte:head>

{#if isAppRoute}
	{@render children()}
{:else}
	<div class="relative min-h-dvh overflow-hidden">
		<div aria-hidden="true" class="bc-appBg pointer-events-none absolute inset-0 -z-10"></div>

		<div class="bc-skip">
			<a class="bc-skipLink" href="#main">Skip to content</a>
		</div>

		<header class="bc-header sticky top-0 z-20">
			<div class="bc-container flex items-center justify-between gap-4 py-4">
				<a href="/" class="bc-chip" aria-label="Go home">
					<div class="bc-logoMark">
						<Bot size={18} strokeWidth={2.25} />
					</div>
					<div class="min-w-0 leading-tight">
						<div class="bc-title text-sm">btca</div>
						<div class="bc-subtitle text-xs">grounded codebase answers</div>
					</div>
				</a>

				<nav aria-label="Primary" class="hidden items-center gap-1 sm:flex">
					<a class="bc-navLink" href="https://docs.btca.dev" target="_blank" rel="noreferrer">
						Docs
					</a>
					<a class={`bc-navLink ${isActive('/cli') ? 'bc-navLink-active' : ''}`} href="/cli">CLI</a>
					<a class={`bc-navLink ${isActive('/web') ? 'bc-navLink-active' : ''}`} href="/web">Web</a>
					<a class={`bc-navLink ${isActive('/pricing') ? 'bc-navLink-active' : ''}`} href="/pricing"
						>Pricing</a
					>
					<a
						class={`bc-navLink ${isActive('/resources') ? 'bc-navLink-active' : ''}`}
						href="/resources">Resources</a
					>
				</nav>

				<div class="flex items-center gap-2">
					<a href="/app" class="bc-chip bc-btnPrimary hidden sm:inline-flex">Try the web app</a>

					<a
						class="bc-chip hidden sm:inline-flex"
						href="https://github.com/bmdavis419/better-context"
						target="_blank"
						rel="noreferrer"
						aria-label="GitHub"
						title="GitHub"
					>
						<GitBranch size={18} strokeWidth={2.25} />
					</a>

					<button
						type="button"
						class="bc-chip"
						onclick={() => theme.toggle()}
						aria-label="Toggle theme"
						title={theme.current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
					>
						{#if theme.current === 'dark'}
							<Sun size={18} strokeWidth={2.25} />
						{:else}
							<Moon size={18} strokeWidth={2.25} />
						{/if}
					</button>

					<button
						type="button"
						class="bc-chip sm:hidden"
						onclick={toggleNav}
						aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
						title={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
					>
						{#if mobileNavOpen}
							<X size={18} strokeWidth={2.25} />
						{:else}
							<Menu size={18} strokeWidth={2.25} />
						{/if}
					</button>
				</div>
			</div>

			{#if mobileNavOpen}
				<div class="bc-container pb-4 sm:hidden">
					<div class="bc-card bc-ring p-2">
						<nav aria-label="Mobile" class="flex flex-col">
							<a class="bc-navLink" href="https://docs.btca.dev" target="_blank" rel="noreferrer">
								Docs
							</a>
							<a class={`bc-navLink ${isActive('/cli') ? 'bc-navLink-active' : ''}`} href="/cli"
								>CLI</a
							>
							<a class={`bc-navLink ${isActive('/web') ? 'bc-navLink-active' : ''}`} href="/web"
								>Web</a
							>
							<a
								class={`bc-navLink ${isActive('/pricing') ? 'bc-navLink-active' : ''}`}
								href="/pricing">Pricing</a
							>
							<a
								class={`bc-navLink ${isActive('/resources') ? 'bc-navLink-active' : ''}`}
								href="/resources">Resources</a
							>
							<a class="bc-navLink" href="/app">Try the web app</a>
							<a
								class="bc-navLink"
								href="https://github.com/bmdavis419/better-context"
								target="_blank"
								rel="noreferrer"
							>
								GitHub
							</a>
						</nav>
					</div>
				</div>
			{/if}
		</header>

		<main id="main" class="bc-container py-12">
			{@render children()}
		</main>

		<footer
			class="mt-10 border-t border-[color-mix(in_oklab,hsl(var(--bc-border))_55%,transparent)]"
		>
			<div class="bc-container grid gap-8 py-12 sm:grid-cols-2">
				<div class="flex flex-col gap-2">
					<div class="text-sm font-semibold tracking-tight">
						Help your AI work from the codebase you actually care about.
					</div>
					<p class="bc-prose text-sm">
						Grounded answers for repos, docs, and config across the CLI, web app, and MCP.
					</p>
				</div>

				<div class="flex flex-wrap items-start gap-2 sm:justify-end">
					<a class="bc-chip" href="https://docs.btca.dev" target="_blank" rel="noreferrer">Docs</a>
					<a class="bc-chip" href="/cli">CLI</a>
					<a class="bc-chip" href="/web">Web</a>
					<a class="bc-chip" href="/pricing">Pricing</a>
					<a class="bc-chip" href="/resources">Resources</a>
				</div>
			</div>
		</footer>
	</div>
{/if}

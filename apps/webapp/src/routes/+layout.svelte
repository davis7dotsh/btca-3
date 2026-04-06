<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import ogImage from '$lib/assets/og.png';
	import { Bot, Menu, Moon, Sun, X } from '@lucide/svelte';
	import { goto, preloadCode, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { theme } from '$lib/stores/theme.svelte';

	let { children } = $props();
	let mobileNavOpen = $state(false);
	let appNavigationPending = $state(false);
	let appPreloadPromise: Promise<unknown> | null = null;

	const appEntryPath = resolve('/app');

	const isAppRoute = $derived(page.url.pathname.startsWith('/app'));
	const pathname = $derived(page.url.pathname);
	const showAppNavigationLoader = $derived(
		!isAppRoute &&
			(appNavigationPending || navigating.to?.url.pathname.startsWith(appEntryPath) === true)
	);

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

	$effect(() => {
		if (!navigating.to) {
			appNavigationPending = false;
		}
	});

	const preloadAppEntry = () => {
		if (!appPreloadPromise) {
			appPreloadPromise = Promise.all([preloadCode(appEntryPath), preloadData(appEntryPath)]).catch(
				() => {
					appPreloadPromise = null;
				}
			);
		}

		return appPreloadPromise;
	};

	const getAppEntryLink = (target: EventTarget | null) => {
		if (!(target instanceof Element)) {
			return null;
		}

		const link = target.closest('a[href]');
		if (!(link instanceof HTMLAnchorElement)) {
			return null;
		}

		const url = new URL(link.href, page.url);

		if (url.origin !== page.url.origin || url.pathname !== appEntryPath) {
			return null;
		}

		return { link, url };
	};

	const shouldHandleAppNavigation = (event: MouseEvent) =>
		!event.defaultPrevented &&
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey;

	const handleDocumentPointerOver = (event: PointerEvent) => {
		if (getAppEntryLink(event.target)) {
			void preloadAppEntry();
		}
	};

	const handleDocumentFocusIn = (event: FocusEvent) => {
		if (getAppEntryLink(event.target)) {
			void preloadAppEntry();
		}
	};

	const handleDocumentClick = (event: MouseEvent) => {
		if (!shouldHandleAppNavigation(event)) {
			return;
		}

		const appLink = getAppEntryLink(event.target);

		if (!appLink) {
			return;
		}

		event.preventDefault();
		appNavigationPending = true;
		void preloadAppEntry();
		void goto(`${appLink.url.pathname}${appLink.url.search}${appLink.url.hash}`, {
			keepFocus: true,
			noScroll: true
		});
	};
</script>

<svelte:body
	onclick={handleDocumentClick}
	onfocusin={handleDocumentFocusIn}
	onpointerover={handleDocumentPointerOver}
/>

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
		{#if showAppNavigationLoader}
			<div
				class="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--bc-bg)/0.82)] backdrop-blur-sm"
				role="status"
				aria-live="polite"
				aria-busy="true"
			>
				<div class="bc-card flex items-center gap-4 px-5 py-4 shadow-[0_20px_60px_hsl(var(--bc-shadow)/0.35)]">
					<div class="bc-logoMark relative z-10">
						<svg
							class="bc-appEntryTrace pointer-events-none absolute inset-0"
							viewBox="0 0 42 42"
							aria-hidden="true"
						>
							<rect class="bc-appEntryTrace-base" x="1" y="1" width="40" height="40" />
							<rect class="bc-appEntryTrace-active" x="1" y="1" width="40" height="40" pathLength="100" />
						</svg>
						<div class="relative z-10 flex size-full items-center justify-center">
							<Bot size={18} strokeWidth={2.25} />
						</div>
					</div>
					<div class="space-y-1">
						<p class="bc-title text-sm text-[hsl(var(--bc-fg))]">Opening the web app</p>
						<p class="text-sm text-[hsl(var(--bc-fg-muted))]">Preparing your workspace…</p>
					</div>
				</div>
			</div>
		{/if}

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
					<a class={`bc-navLink ${isActive('/pricing') ? 'bc-navLink-active' : ''}`} href="/pricing"
						>Pricing</a
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
						<svg viewBox="0 0 24 24" aria-hidden="true" class="h-[18px] w-[18px] fill-current">
							<path
								d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.69.08-.69 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.67 1.24 3.32.95.1-.74.4-1.24.72-1.52-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.3 1.18-3.12-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.14 1.19A10.9 10.9 0 0 1 12 6.03c.98 0 1.97.13 2.89.38 2.19-1.5 3.14-1.19 3.14-1.19.63 1.58.24 2.75.12 3.04.73.82 1.18 1.86 1.18 3.12 0 4.42-2.69 5.39-5.25 5.67.41.35.77 1.03.77 2.08 0 1.5-.01 2.71-.01 3.08 0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
							/>
						</svg>
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
							<a
								class={`bc-navLink ${isActive('/pricing') ? 'bc-navLink-active' : ''}`}
								href="/pricing">Pricing</a
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

<style>
	.bc-appEntryTrace {
		width: 100%;
		height: 100%;
	}

	.bc-appEntryTrace rect {
		fill: none;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
		shape-rendering: geometricPrecision;
	}

	.bc-appEntryTrace-base {
		stroke: color-mix(in oklab, hsl(var(--bc-border)) 55%, transparent);
	}

	.bc-appEntryTrace-active {
		stroke: hsl(var(--bc-accent));
		stroke-dasharray: 8 92;
		stroke-dashoffset: 2;
		animation: bc-app-entry-trace 1.05s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.bc-appEntryTrace-active {
			animation: none;
			stroke-dasharray: 100 0;
			opacity: 0.45;
		}
	}

	@keyframes bc-app-entry-trace {
		from {
			stroke-dashoffset: 0;
		}

		to {
			stroke-dashoffset: -100;
		}
	}
</style>

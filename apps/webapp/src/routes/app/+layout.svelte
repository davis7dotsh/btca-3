<script lang="ts">
	import { Bot, Menu } from '@lucide/svelte';
	import ConvexWrapper from '$lib/wrappers/ConvexWrapper.svelte';
	import AppSidebar from '$lib/components/AppSidebar.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { resolve } from '$app/paths';
	import { setAuthContext } from '$lib/stores/auth.svelte';
	import { page } from '$app/state';

	const { children } = $props();
	const authContext = setAuthContext();

	let sidebarOpen = $state(false);
	let commandPaletteOpen = $state(false);

	function handleGlobalKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			commandPaletteOpen = !commandPaletteOpen;
		}
	}

	$effect(() => {
		if (!page.url.pathname) {
			return;
		}

		sidebarOpen = false;
		commandPaletteOpen = false;
	});
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<svelte:head>
	<title>btca web | App</title>
</svelte:head>

{#if authContext.isLoaded}
	<ConvexWrapper>
		{#if !authContext.currentUser}
			<div
				class="relative flex min-h-screen items-center justify-center overflow-hidden bg-[hsl(var(--bc-bg))] p-6"
			>
				<div aria-hidden="true" class="bc-appBg absolute inset-0"></div>
				<div
					aria-hidden="true"
					class="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,rgba(71,131,235,0.14),transparent_70%)]"
				></div>

				<div class="bc-card bc-reveal relative z-10 w-full max-w-md p-8">
					<div class="mb-8 space-y-4">
						<div class="bc-logoMark">
							<Bot size={18} strokeWidth={2.25} />
						</div>
						<h1 class="bc-title text-2xl">Sign in to btca web</h1>
					</div>

					<div class="space-y-4">
						<a
							href={resolve('/auth/login')}
							class="bc-btn bc-btn-primary inline-flex w-full items-center justify-center"
						>
							Sign in
						</a>

						{#if authContext.errorMessage}
							<p class="text-sm text-[hsl(var(--bc-error))]">{authContext.errorMessage}</p>
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<div class="relative flex h-dvh overflow-hidden bg-[hsl(var(--bc-bg))] text-[hsl(var(--bc-fg))]">
				<div aria-hidden="true" class="bc-appBg pointer-events-none absolute inset-0 -z-10"></div>

				<button
					type="button"
					class="bc-iconBtn fixed left-4 top-4 z-50 lg:hidden"
					onclick={() => (sidebarOpen = true)}
					aria-label="Open sidebar"
				>
					<Menu size={18} />
				</button>

				<aside
					class={`fixed inset-y-0 left-0 z-40 w-[18.5rem] shrink-0 transform border-r border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] transition-transform duration-200 ease-out lg:relative lg:translate-x-0 ${
						sidebarOpen ? 'translate-x-0' : '-translate-x-full'
					}`}
				>
					<AppSidebar
						isOpen={sidebarOpen}
						onOpenCommandPalette={() => (commandPaletteOpen = true)}
						onClose={() => (sidebarOpen = false)}
					/>
				</aside>

				{#if sidebarOpen}
					<button
						type="button"
						class="fixed inset-0 z-30 bg-black/55 lg:hidden"
						onclick={() => (sidebarOpen = false)}
						aria-label="Close sidebar"
					></button>
				{/if}

				<main class="bc-page-enter relative flex min-h-0 flex-1 flex-col">
					{@render children()}
				</main>
			</div>

			<CommandPalette
				isOpen={commandPaletteOpen}
				onClose={() => (commandPaletteOpen = false)}
			/>
		{/if}
	</ConvexWrapper>
{:else}
	<div
		class="flex min-h-screen items-center justify-center bg-[hsl(var(--bc-bg))] text-sm text-[hsl(var(--bc-fg-muted))]"
	>
		Loading...
	</div>
{/if}

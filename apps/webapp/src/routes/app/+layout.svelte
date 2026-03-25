<script lang="ts">
	import ConvexWrapper from '$lib/wrappers/ConvexWrapper.svelte';
	import AppSidebar from '$lib/components/AppSidebar.svelte';
	import { resolve } from '$app/paths';
	import { setAuthContext } from '$lib/stores/auth.svelte';

	const { children } = $props();
	const authContext = setAuthContext();
</script>

<svelte:head>
	<title>pi land | App</title>
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
						<div class="bc-logoMark">PL</div>
						<h1 class="bc-title text-2xl">Sign in to pi land</h1>
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
			<div class="flex h-screen bg-[hsl(var(--bc-bg))] text-[hsl(var(--bc-fg))]">
				<AppSidebar />
				<main class="bc-page-enter flex min-h-0 flex-1 flex-col">
					{@render children()}
				</main>
			</div>
		{/if}
	</ConvexWrapper>
{:else}
	<div
		class="flex min-h-screen items-center justify-center bg-[hsl(var(--bc-bg))] text-sm text-[hsl(var(--bc-fg-muted))]"
	>
		Loading...
	</div>
{/if}

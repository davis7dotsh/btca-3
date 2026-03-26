<script lang="ts">
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import { theme } from '$lib/stores/theme.svelte';

	const authContext = getAuthContext();
	const displayName = $derived(
		authContext.currentUser?.firstName ?? authContext.currentUser?.email ?? 'Signed in user'
	);
</script>

<svelte:head>
	<title>btca web | Settings</title>
</svelte:head>

<div class="bc-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto bg-[hsl(var(--bc-bg))]">
	<div class="bc-reveal mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
		<header class="space-y-2">
			<p class="bc-kicker">
				<span class="bc-kickerDot"></span>
				Settings
			</p>
			<h1 class="bc-title text-2xl">Settings</h1>
		</header>

		<section class="bc-card p-5">
			<h2 class="bc-title text-base">Account</h2>

			<div class="mt-4 space-y-4">
				<div class="space-y-1.5">
					<p class="text-sm font-medium">Name</p>
					<div
						class="border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm"
					>
						{displayName}
					</div>
				</div>

				<div class="space-y-1.5">
					<p class="text-sm font-medium">Email</p>
					<div
						class="border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg))] px-4 py-2.5 text-sm"
					>
						{authContext.currentUser?.email ?? 'No email available'}
					</div>
				</div>
			</div>
		</section>

		<section class="bc-card p-5">
			<h2 class="bc-title text-base">Appearance</h2>

			<div class="mt-4 flex flex-wrap gap-3">
				<button
					type="button"
					class={[
						'bc-btn',
						theme.current === 'dark' && 'border-[hsl(var(--bc-accent))] text-[hsl(var(--bc-fg))]'
					]}
					onclick={() => theme.set('dark')}
				>
					Dark
				</button>
				<button
					type="button"
					class={[
						'bc-btn',
						theme.current === 'light' && 'border-[hsl(var(--bc-accent))] text-[hsl(var(--bc-fg))]'
					]}
					onclick={() => theme.set('light')}
				>
					Light
				</button>
			</div>
		</section>
	</div>
</div>

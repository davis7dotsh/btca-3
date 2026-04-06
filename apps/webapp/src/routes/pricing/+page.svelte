<script lang="ts">
	import PricingPlans from '$lib/components/pricing/PricingPlans.svelte';
	import { goto } from '$app/navigation';

	function handleSignIn() {
		goto('/app');
	}
</script>

<svelte:head>
	<title>btca | Pricing</title>
	<meta name="description" content="Simple pricing for grounded codebase research with btca." />
</svelte:head>

<section class="flex flex-col gap-12">
	<header class="flex flex-col gap-5">
		<div class="bc-kicker">
			<span class="bc-kickerDot"></span>
			<span>Pricing</span>
		</div>
		<h1 class="bc-h1 text-balance text-5xl sm:text-6xl">
			Search git repos, npm packages, the web, and more.
		</h1>
	</header>

	<div class="mx-auto w-full max-w-5xl">
		<PricingPlans isSignedIn={false} isSubscribed={false} onSignIn={handleSignIn} />
	</div>
</section>

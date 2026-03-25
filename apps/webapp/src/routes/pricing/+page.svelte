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
			Simple pricing for grounded codebase research.
		</h1>
		<p class="bc-prose max-w-2xl text-pretty text-base sm:text-lg">
			Use btca in the web app to search codebases, save threads, and connect coding tools through
			Cloud MCP.
		</p>
	</header>

	<div class="mx-auto w-full max-w-5xl">
		<PricingPlans isSignedIn={false} isSubscribed={false} onSignIn={handleSignIn} />
	</div>
</section>

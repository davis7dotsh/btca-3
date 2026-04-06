<script lang="ts">
	import { Check, Loader2 } from '@lucide/svelte';
	import { BILLING_PLAN } from '$lib/billing/plans';

	type Props = {
		isSubscribed?: boolean;
		isSignedIn?: boolean;
		onCheckout?: () => void | Promise<void>;
		onSignIn?: () => void;
		usageHref?: string;
		isRedirecting?: boolean;
		errorMessage?: string | null;
	};

	let {
		isSubscribed = false,
		isSignedIn = false,
		onCheckout,
		onSignIn,
		usageHref = '/app/billing',
		isRedirecting = false,
		errorMessage = null
	}: Props = $props();

	const features = [
		'Monthly usage allowance',
		'Full web app access',
		'MCP server access',
	];

	function handleAction() {
		if (!isSignedIn && onSignIn) {
			onSignIn();
			return;
		}
		if (onCheckout) {
			void onCheckout();
		}
	}
</script>

<div class="flex w-full flex-col">
	<section class="grid gap-6 lg:grid-cols-2">
		<div class="bc-card bc-reveal p-8" style="--delay: 60ms">
			<div class="flex items-baseline justify-between">
				<div>
					<p class="bc-muted text-sm font-medium">Trial</p>
					<h3 class="mt-2 text-3xl font-semibold">$0</h3>
					<p class="bc-muted text-xs">one-time</p>
				</div>
				<span class="bc-badge">Start here</span>
			</div>
			<p class="mt-4 text-sm font-medium">Try btca web</p>
			<ul class="mt-6 grid gap-3 text-sm">
				<li class="flex items-start gap-3">
					<Check size={18} class="mt-0.5 text-[hsl(var(--bc-success))]" />
					<span>One-time trial allowance</span>
				</li>
			</ul>
		</div>

		<div class="bc-card bc-reveal p-8" style="--delay: 90ms">
			<div class="flex items-baseline justify-between">
				<div>
					<p class="bc-muted text-sm font-medium">Pro</p>
					<h3 class="mt-2 text-3xl font-semibold">${BILLING_PLAN.priceUsd}</h3>
					<p class="bc-muted text-xs">per month</p>
				</div>
				<span class="bc-badge">Cancel anytime</span>
			</div>
			<p class="mt-4 text-sm font-medium">Deeper codebase research</p>
			<ul class="mt-6 grid gap-3 text-sm">
				{#each features as feature}
					<li class="flex items-start gap-3">
						<Check size={18} class="mt-0.5 text-[hsl(var(--bc-success))]" />
						<span>{feature}</span>
					</li>
				{/each}
			</ul>
			{#if errorMessage}
				<p class="mt-4 text-xs text-red-500">{errorMessage}</p>
			{/if}
			{#if isSubscribed}
				<a href={usageHref} class="bc-btn bc-btn-primary mt-6 w-full">View usage</a>
			{:else}
				<button
					type="button"
					class="bc-btn bc-btn-primary mt-6 w-full"
					onclick={handleAction}
					disabled={isRedirecting}
				>
					{#if isRedirecting}
						<Loader2 size={16} class="animate-spin" />
						Starting checkout...
					{:else if !isSignedIn}
						Start Trial
					{:else}
						Upgrade to Pro
					{/if}
				</button>
			{/if}
		</div>
	</section>
</div>

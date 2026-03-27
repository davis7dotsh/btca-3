<script lang="ts">
	import { Bot } from '@lucide/svelte';
</script>

<div
	class="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[hsl(var(--bc-bg))] p-6"
	role="status"
	aria-live="polite"
	aria-busy="true"
>
	<span class="sr-only">Loading application</span>

	<div aria-hidden="true" class="bc-appBg pointer-events-none absolute inset-0"></div>
	<div
		aria-hidden="true"
		class="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,rgba(71,131,235,0.14),transparent_70%)]"
	></div>

	<div class="bc-reveal relative z-10 flex flex-col items-center gap-8">
		<div class="relative flex size-20 items-center justify-center">
			<div
				class="pointer-events-none absolute inset-0 border-2 border-[color-mix(in_oklab,hsl(var(--bc-border))_55%,transparent)] border-t-[hsl(var(--bc-accent))] opacity-90 [animation-duration:1.25s] motion-reduce:animate-none motion-reduce:opacity-40 animate-spin"
				style="border-radius: 9999px"
			></div>
			<div class="bc-logoMark relative z-10">
				<Bot size={18} strokeWidth={2.25} />
			</div>
		</div>

		<div class="flex flex-col items-center gap-3">
			<p class="bc-title text-sm tracking-tight text-[hsl(var(--bc-fg))]">Preparing your workspace</p>
			<div class="flex items-center gap-1.5" aria-hidden="true">
				<span class="bc-appShell-dot bc-appShell-dot-1"></span>
				<span class="bc-appShell-dot bc-appShell-dot-2"></span>
				<span class="bc-appShell-dot bc-appShell-dot-3"></span>
			</div>
		</div>
	</div>
</div>

<style>
	.bc-appShell-dot {
		display: block;
		width: 6px;
		height: 6px;
		background: hsl(var(--bc-accent));
		/* global layout.css forces Tailwind rounded-* to 0 */
		border-radius: 9999px;
		animation: bc-app-shell-dot 1.05s ease-in-out infinite;
	}

	.bc-appShell-dot-1 {
		animation-delay: 0ms;
	}

	.bc-appShell-dot-2 {
		animation-delay: 0.14s;
	}

	.bc-appShell-dot-3 {
		animation-delay: 0.28s;
	}

	@media (prefers-reduced-motion: reduce) {
		.bc-appShell-dot {
			animation: none;
			opacity: 0.55;
		}
	}

	@keyframes bc-app-shell-dot {
		0%,
		70%,
		100% {
			opacity: 0.2;
			transform: translateY(0) scale(0.92);
		}

		35% {
			opacity: 1;
			transform: translateY(-3px) scale(1);
		}
	}
</style>

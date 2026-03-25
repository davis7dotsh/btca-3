<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	$effect(() => {
		const threadId = page.url.searchParams.get('thread');

		if (threadId) {
			void goto(resolve(`/app/chat/${encodeURIComponent(threadId)}`), {
				replaceState: true,
				noScroll: true,
				keepFocus: true
			});
			return;
		}

		void goto(resolve('/app/chat'), {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
	});
</script>

<div class="flex min-h-0 flex-1 items-center justify-center bg-[hsl(var(--bc-bg))]">
	<p class="text-sm text-[hsl(var(--bc-fg-muted))]">Opening chat...</p>
</div>

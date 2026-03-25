<script lang="ts">
	import { isHttpError } from '@sveltejs/kit';

	const { error }: { error: unknown } = $props();

	const parsedError = $derived.by((): App.Error => {
		if (isHttpError(error)) {
			return error.body;
		}

		console.error(error);

		return {
			message: 'Unknown error',
			kind: 'UnknownError',
			timestamp: Date.now()
		};
	});
</script>

<div class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
	<p class="font-semibold">{parsedError.message}</p>
	{#if parsedError.traceId}
		<p class="mt-2 text-red-700">Share this trace ID if you need support: {parsedError.traceId}</p>
	{/if}
</div>

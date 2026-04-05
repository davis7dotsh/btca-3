<script lang="ts">
	import { browser } from '$app/environment';
	import { api } from '@btca/convex/api';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { getHumanErrorMessage } from '$lib/errors';
	import { getAuthContext } from '$lib/stores/auth.svelte';

	type MigrationStatus = {
		key: string;
		status: 'not_started' | 'running' | 'completed' | 'failed';
		shouldAutoStart: boolean;
		startedAt: number | null;
		completedAt: number | null;
		updatedAt: number;
		errorMessage: string | null;
	};

	type QueryState<T> = {
		data: T | undefined;
		isLoading: boolean;
		error: unknown;
	};

	const authContext = getAuthContext();
	const convex = browser ? useConvexClient() : null;

	const migrationQuery: QueryState<MigrationStatus> = browser
		? useQuery(
				api.authed.migrations.getStatus,
				() => (authContext.currentUser ? {} : 'skip'),
				() => ({ keepPreviousData: true })
			)
		: {
				data: undefined,
				isLoading: false,
				error: null
			};

	let isStarting = $state(false);
	let lastAutoStartKey = $state<string | null>(null);

	const migration = $derived(migrationQuery.data ?? null);
	const autoStartKey = $derived.by(() => {
		if (!authContext.currentUser || !migration?.shouldAutoStart) {
			return null;
		}

		return `${authContext.currentUser.id}:${migration.status}:${migration.updatedAt}`;
	});
	const showBanner = $derived(migration?.status === 'running' || isStarting);
	const bannerMessage = $derived(
		migration?.status === 'running'
			? 'Your old threads and resources are being migrated. Give us a minute.'
			: isStarting
				? 'Bringing over your old data.'
				: null
	);

	async function startMigration() {
		if (!convex || isStarting) {
			return;
		}

		isStarting = true;

		try {
			await convex.mutation(api.authed.migrations.start, {});
		} catch (error) {
			console.error('Failed to start legacy data migration', {
				error: getHumanErrorMessage(error, 'Failed to start your data migration.')
			});
		} finally {
			isStarting = false;
		}
	}

	$effect(() => {
		const key = autoStartKey;

		if (!key || lastAutoStartKey === key) {
			return;
		}

		lastAutoStartKey = key;
		void startMigration();
	});
</script>

{#if showBanner && bannerMessage}
	<div
		class="border-b border-[hsl(var(--bc-border))] bg-[linear-gradient(90deg,hsl(var(--bc-surface-2))/0.92,rgba(71,131,235,0.12),hsl(var(--bc-surface-2))/0.92)] px-4 py-2 text-xs text-[hsl(var(--bc-fg-muted))] backdrop-blur"
	>
		<div class="mx-auto flex w-full max-w-5xl items-center gap-2.5">
			<div class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[hsl(var(--bc-accent))]"></div>
			<p>{bannerMessage}</p>
		</div>
	</div>
{/if}

<script lang="ts">
	import { CONVEX_URL } from '$lib/convex-env';
	import { getAuthContext } from '$lib/stores/auth.svelte';
	import { setupConvex, useConvexClient } from 'convex-svelte';

	const authContext = getAuthContext();

	const getAuthToken = async () => {
		if (!authContext.currentUser) {
			return null;
		}

		const response = await fetch('/auth/token', {
			headers: {
				accept: 'application/json'
			},
			cache: 'no-store'
		});

		if (response.status === 401) {
			return null;
		}

		if (!response.ok) {
			throw new Error(`Failed to load WorkOS token (${response.status})`);
		}

		const data = (await response.json()) as {
			accessToken: string;
		};

		return data.accessToken;
	};

	setupConvex(CONVEX_URL);

	const convex = useConvexClient();
	convex.setAuth(getAuthToken);

	const { children } = $props();
</script>

{@render children()}

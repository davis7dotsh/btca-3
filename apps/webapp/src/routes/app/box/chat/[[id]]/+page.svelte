<script lang="ts">
	import AgentChat from '$lib/components/AgentChat.svelte';
</script>

<svelte:head>
	<title>pi land | Box Chat</title>
</svelte:head>

<AgentChat routeBase="/app/box/chat" agentApiPath="/api/box-agent" />

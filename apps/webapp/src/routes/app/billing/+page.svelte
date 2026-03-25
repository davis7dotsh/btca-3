<script lang="ts">
  import { onMount } from "svelte";
  import { BILLING_PLAN, FREE_BILLING_PLAN } from "$lib/billing/plans";
  import { getAuthContext } from "$lib/stores/auth.svelte";

  interface BillingUsageState {
    granted: number;
    remaining: number;
    used: number;
    remainingPercentage: number;
    nextResetAt: number | null;
    isLifetime: boolean;
  }

  interface BillingPageState {
    enabled: boolean;
    currentPlan: string;
    hasPaidPlan: boolean;
    usage: BillingUsageState;
    plans: {
      free: typeof FREE_BILLING_PLAN;
      pro: typeof BILLING_PLAN;
    };
  }

  const authContext = getAuthContext();

  let billingState = $state.raw<BillingPageState | null>(null);
  let billingError = $state<string | null>(null);
  let isLoading = $state(true);
  let checkoutPending = $state(false);
  let portalPending = $state(false);
  let loadedUserId = $state<string | null>(null);

  const currentUserId = $derived(authContext.currentUser?.id ?? null);
  const isAuthenticated = $derived(authContext.status === "authenticated");
  const currentPlanId = $derived(billingState?.currentPlan ?? FREE_BILLING_PLAN.id);
  const usage = $derived(
    billingState?.usage ?? {
      granted: FREE_BILLING_PLAN.limits.usageUsd,
      remaining: FREE_BILLING_PLAN.limits.usageUsd,
      used: 0,
      remainingPercentage: 100,
      nextResetAt: null,
      isLifetime: true,
    },
  );
  const isFreePlan = $derived(currentPlanId === FREE_BILLING_PLAN.id);
  const usageBarWidth = $derived(`width: ${usage.remainingPercentage}%`);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: value < 10 ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(value);

  const formatResetLabel = (nextResetAt: number | null, isLifetime: boolean) => {
    if (isLifetime || nextResetAt === null) {
      return "Lifetime allowance";
    }

    return `Resets ${new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(nextResetAt)}`;
  };

  const toHumanMessage = async (response: Response, fallback: string) => {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    return payload?.message ?? fallback;
  };

  const loadBilling = async () => {
    if (!isAuthenticated || !currentUserId) {
      isLoading = false;
      billingState = null;
      return;
    }

    try {
      billingError = null;
      const response = await fetch("/api/billing", {
        cache: "no-store",
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(await toHumanMessage(response, "Failed to load billing."));
      }

      billingState = (await response.json()) as BillingPageState;
      loadedUserId = currentUserId;
    } catch (error) {
      billingError = error instanceof Error ? error.message : "Failed to load billing.";
    } finally {
      isLoading = false;
    }
  };

  const runBillingAction = async (action: "checkout" | "portal") => {
    if (!isAuthenticated) {
      billingError = "Sign in to manage billing.";
      return;
    }

    if (action === "checkout") {
      checkoutPending = true;
    } else {
      portalPending = true;
    }

    try {
      billingError = null;
      const response = await fetch("/api/billing", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ action }),
      });

      if (!response.ok) {
        throw new Error(await toHumanMessage(response, "Failed to start billing flow."));
      }

      const payload = (await response.json()) as { url: string };
      window.location.assign(payload.url);
    } catch (error) {
      billingError = error instanceof Error ? error.message : "Failed to start billing flow.";
      checkoutPending = false;
      portalPending = false;
    }
  };

  onMount(() => {
    if (authContext.status !== "loading") {
      void loadBilling();
    }
  });

  $effect(() => {
    if (authContext.status === "loading") {
      return;
    }

    if (!isAuthenticated) {
      isLoading = false;
      billingState = null;
      loadedUserId = null;
      return;
    }

    if (currentUserId && loadedUserId !== currentUserId) {
      isLoading = true;
      void loadBilling();
    }
  });
</script>

<svelte:head>
  <title>pi land | Billing</title>
</svelte:head>

<div class="bc-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto bg-[hsl(var(--bc-bg))]">
  <div class="bc-reveal mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
    <header class="space-y-2">
      <p class="bc-kicker">
        <span class="bc-kickerDot"></span>
        Billing
      </p>
      <h1 class="bc-title text-2xl">Usage and billing</h1>
      <p class="bc-muted max-w-2xl text-sm">
        Free users get {formatCurrency(FREE_BILLING_PLAN.limits.usageUsd)} lifetime. Pro includes
        {formatCurrency(BILLING_PLAN.limits.usageUsd)} every month.
      </p>
    </header>

    {#if billingError}
      <section class="bc-card border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
        {billingError}
      </section>
    {/if}

    <section class="bc-card grid gap-6 p-6 lg:grid-cols-[1.35fr_0.85fr]">
      <div class="space-y-6">
        <div class="space-y-2">
          <p class="text-sm font-medium text-[hsl(var(--bc-fg-muted))]">
            {usage.isLifetime ? "Lifetime usage limit" : "Monthly usage limit"}
          </p>
          <div class="flex flex-wrap items-end gap-3">
            <p class="text-5xl font-semibold tracking-tight">{usage.remainingPercentage}%</p>
            <p class="pb-1 text-2xl text-[hsl(var(--bc-fg-muted))]">remaining</p>
          </div>
        </div>

        <div class="space-y-3">
          <div class="h-5 overflow-hidden rounded-full bg-white/15">
            <div
              class="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
              style={usageBarWidth}
            ></div>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-[hsl(var(--bc-fg-muted))]">
            <p>{formatCurrency(usage.remaining)} remaining of {formatCurrency(usage.granted)}</p>
            <p>{formatResetLabel(usage.nextResetAt, usage.isLifetime)}</p>
          </div>
        </div>
      </div>

      <div class="rounded-[1.5rem] border border-[hsl(var(--bc-border))] bg-[hsl(var(--bc-bg-subtle))] p-5">
        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-[hsl(var(--bc-fg-muted))]">
          Current plan
        </p>
        <h2 class="mt-3 text-2xl font-semibold">{isFreePlan ? "Free" : "Pro"}</h2>
        <p class="bc-muted mt-2 text-sm">
          {isFreePlan
            ? "One lifetime usage wallet before upgrade is required."
            : "Monthly usage wallet with hosted checkout and self-serve billing management."}
        </p>

        <div class="mt-6 flex flex-col gap-3">
          <button
            type="button"
            class="bc-btn bc-btn-primary w-full justify-center"
            onclick={() => runBillingAction("checkout")}
            disabled={!isAuthenticated || checkoutPending || billingState?.hasPaidPlan}
          >
            {#if checkoutPending}
              Starting checkout...
            {:else if billingState?.hasPaidPlan}
              Pro active
            {:else}
              Upgrade to Pro
            {/if}
          </button>

          <button
            type="button"
            class="bc-btn w-full justify-center"
            onclick={() => runBillingAction("portal")}
            disabled={!isAuthenticated || portalPending || !billingState?.hasPaidPlan}
          >
            {portalPending ? "Opening portal..." : "Manage billing"}
          </button>

          <button
            type="button"
            class="bc-btn w-full justify-center"
            onclick={() => {
              isLoading = true;
              void loadBilling();
            }}
            disabled={isLoading}
          >
            {isLoading ? "Refreshing..." : "Refresh usage"}
          </button>
        </div>
      </div>
    </section>

    <section class="grid gap-6 lg:grid-cols-2">
      <article class="bc-card p-6">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.18em] text-[hsl(var(--bc-fg-muted))]">
              Free
            </p>
            <h2 class="mt-2 text-2xl font-semibold">{formatCurrency(0)}</h2>
          </div>
          {#if currentPlanId === FREE_BILLING_PLAN.id}
            <span
              class="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200"
            >
              Current
            </span>
          {/if}
        </div>

        <p class="bc-muted mt-4 text-sm">
          {formatCurrency(FREE_BILLING_PLAN.limits.usageUsd)} lifetime usage before upgrade is
          required.
        </p>
      </article>

      <article class="bc-card p-6">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.18em] text-[hsl(var(--bc-fg-muted))]">
              Pro
            </p>
            <h2 class="mt-2 text-2xl font-semibold">
              {formatCurrency(BILLING_PLAN.priceUsd)}
              <span class="ml-1 text-base font-normal text-[hsl(var(--bc-fg-muted))]">/ month</span>
            </h2>
          </div>
          {#if currentPlanId === BILLING_PLAN.id}
            <span
              class="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200"
            >
              Current
            </span>
          {/if}
        </div>

        <div class="mt-4 space-y-3 text-sm">
          <p>{formatCurrency(BILLING_PLAN.limits.usageUsd)} included every month</p>
          <p class="bc-muted">Usage is metered from model tokens, Exa requests, and Box compute.</p>
          <p class="bc-muted">Hosted checkout and self-serve management portal are included.</p>
        </div>
      </article>
    </section>
  </div>
</div>

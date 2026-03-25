export const AUTUMN_USAGE_FEATURE = {
  id: "usage_usd",
  name: "Usage Wallet",
  type: "metered",
  consumable: true,
} as const;

export const AUTUMN_FREE_PLAN = {
  id: "free_plan",
  name: "Free",
  autoEnable: true,
  includedUsageUsd: 1,
  interval: "lifetime",
  priceUsd: 0,
  description: "Try btca on a real codebase",
  buttonText: "Start with Free",
} as const;

export const AUTUMN_PRO_PLAN = {
  id: "btca_pro",
  name: "Pro",
  includedUsageUsd: 6,
  interval: "month",
  priceUsd: 8,
  description: "For solo developers doing ongoing codebase research",
  buttonText: "Upgrade to Pro",
} as const;

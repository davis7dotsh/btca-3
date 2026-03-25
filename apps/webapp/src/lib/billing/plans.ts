export const FREE_BILLING_PLAN = {
  id: "free_plan",
  name: "Free",
  priceUsd: 0,
  interval: "lifetime",
  limits: {
    usageUsd: 1,
  },
} as const;

export const BILLING_PLAN = {
  id: "btca_pro",
  name: "Pro",
  priceUsd: 8,
  interval: "month",
  model: "claude-haiku-4-5",
  limits: {
    usageUsd: 6,
  },
} as const;

export const FEATURE_IDS = {
  usageUsd: "usage_usd",
} as const;

export const SUPPORT_URL = "https://x.com/davis7";

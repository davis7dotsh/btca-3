import { AUTUMN_FREE_PLAN, AUTUMN_PRO_PLAN, AUTUMN_USAGE_FEATURE } from "@btca/autumn/config";

export const FREE_BILLING_PLAN = {
  id: AUTUMN_FREE_PLAN.id,
  name: AUTUMN_FREE_PLAN.name,
  priceUsd: AUTUMN_FREE_PLAN.priceUsd,
  interval: AUTUMN_FREE_PLAN.interval,
  limits: {
    usageUsd: AUTUMN_FREE_PLAN.includedUsageUsd,
  },
} as const;

export const BILLING_PLAN = {
  id: AUTUMN_PRO_PLAN.id,
  name: AUTUMN_PRO_PLAN.name,
  priceUsd: AUTUMN_PRO_PLAN.priceUsd,
  interval: AUTUMN_PRO_PLAN.interval,
  model: "claude-haiku-4-5",
  limits: {
    usageUsd: AUTUMN_PRO_PLAN.includedUsageUsd,
  },
} as const;

export const FEATURE_IDS = {
  usageUsd: AUTUMN_USAGE_FEATURE.id,
} as const;

export const SUPPORT_URL = "https://x.com/davis7";

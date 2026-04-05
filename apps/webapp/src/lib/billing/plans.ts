import { AUTUMN_CONFIG } from "@btca/autumn/config";

const usageFeature = AUTUMN_CONFIG.features.usage_usd;
const freePlanConfig = AUTUMN_CONFIG.plans.free_plan;
const proPlanConfig = AUTUMN_CONFIG.plans.btca_pro;
const freePlanItems = freePlanConfig.items ?? [];
const proPlanItems = proPlanConfig.items ?? [];

const freePlanUsageUsd =
  freePlanItems.find((item) => item.featureId === usageFeature.id)?.included ?? 0;

const proPlanUsageUsd =
  proPlanItems.find((item) => item.featureId === usageFeature.id)?.included ?? 0;

export const FREE_BILLING_PLAN = {
  id: freePlanConfig.id,
  name: "Trial",
  priceUsd: 0,
  interval: "lifetime",
  limits: {
    usageUsd: freePlanUsageUsd,
  },
} as const;

export const BILLING_PLAN = {
  id: proPlanConfig.id,
  name: "Pro",
  priceUsd: proPlanConfig.price?.amount ?? 0,
  interval: proPlanConfig.price?.interval ?? "month",
  model: "claude-haiku-4-5",
  limits: {
    usageUsd: proPlanUsageUsd,
  },
} as const;

export const FEATURE_IDS = {
  usageUsd: usageFeature.id,
} as const;

export const SUPPORT_URL = "https://x.com/davis7";

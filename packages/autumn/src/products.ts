import { CheckEnv, type Product } from "autumn-js";
import { AUTUMN_FREE_PLAN, AUTUMN_PRO_PLAN, AUTUMN_USAGE_FEATURE } from "./config.ts";

const baseProduct = {
  archived: false,
  createdAt: 0,
  env: CheckEnv.Sandbox,
  isAddOn: false,
  group: "default",
  version: 1,
  freeTrial: null,
  baseVariantId: null,
} as const;

export const autumnProducts = [
  {
    ...baseProduct,
    id: AUTUMN_FREE_PLAN.id,
    name: "Free Plan",
    isDefault: true,
    items: [
      {
        type: "feature",
        featureId: AUTUMN_USAGE_FEATURE.id,
        includedUsage: AUTUMN_FREE_PLAN.includedUsageUsd,
      },
    ],
    properties: {
      isFree: true,
      isOneOff: false,
      intervalGroup: "",
      hasTrial: false,
      updateable: true,
    },
  },
  {
    ...baseProduct,
    id: AUTUMN_PRO_PLAN.id,
    name: "Pro Plan",
    isDefault: false,
    items: [
      {
        type: "price",
        price: AUTUMN_PRO_PLAN.priceUsd,
        interval: AUTUMN_PRO_PLAN.interval,
      },
      {
        type: "feature",
        featureId: AUTUMN_USAGE_FEATURE.id,
        includedUsage: AUTUMN_PRO_PLAN.includedUsageUsd,
        interval: AUTUMN_PRO_PLAN.interval,
      },
    ],
    properties: {
      isFree: false,
      isOneOff: false,
      intervalGroup: "month",
      hasTrial: false,
      updateable: true,
    },
  },
] as const satisfies readonly Product[];

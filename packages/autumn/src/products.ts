import { AppEnv, type Product } from "autumn-js";
import { AUTUMN_FREE_PLAN, AUTUMN_PRO_PLAN, AUTUMN_USAGE_FEATURE } from "./config.ts";

const baseProduct = {
  created_at: 0,
  env: AppEnv.Sandbox,
  is_add_on: false,
  group: "default",
  version: 1,
  free_trial: null,
  base_variant_id: null,
} as const;

export const autumnProducts = [
  {
    ...baseProduct,
    id: AUTUMN_FREE_PLAN.id,
    name: "Free Plan",
    is_default: true,
    items: [
      {
        type: "feature",
        feature_id: AUTUMN_USAGE_FEATURE.id,
        included_usage: AUTUMN_FREE_PLAN.includedUsageUsd,
      },
    ],
    properties: {
      is_free: true,
      is_one_off: false,
      interval_group: "",
      has_trial: false,
      updateable: true,
    },
    display: {
      name: AUTUMN_FREE_PLAN.name,
      description: AUTUMN_FREE_PLAN.description,
      button_text: AUTUMN_FREE_PLAN.buttonText,
    },
  },
  {
    ...baseProduct,
    id: AUTUMN_PRO_PLAN.id,
    name: "Pro Plan",
    is_default: false,
    items: [
      {
        type: "price",
        price: AUTUMN_PRO_PLAN.priceUsd,
        interval: AUTUMN_PRO_PLAN.interval,
      },
      {
        type: "feature",
        feature_id: AUTUMN_USAGE_FEATURE.id,
        included_usage: AUTUMN_PRO_PLAN.includedUsageUsd,
        interval: AUTUMN_PRO_PLAN.interval,
      },
    ],
    properties: {
      is_free: false,
      is_one_off: false,
      interval_group: "month",
      has_trial: false,
      updateable: true,
    },
    display: {
      name: AUTUMN_PRO_PLAN.name,
      description: AUTUMN_PRO_PLAN.description,
      button_text: AUTUMN_PRO_PLAN.buttonText,
    },
  },
] as const satisfies readonly Product[];

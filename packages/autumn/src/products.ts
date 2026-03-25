import { AppEnv, type Product } from "autumn-js";

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
    id: "free_plan",
    name: "Free Plan",
    is_default: true,
    items: [
      {
        type: "feature",
        feature_id: "chat_messages",
        included_usage: 5,
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
      name: "Free",
      description: "Try btca on a real codebase",
      button_text: "Start with Free",
    },
  },
  {
    ...baseProduct,
    id: "btca_pro",
    name: "Pro Plan",
    is_default: false,
    items: [
      {
        type: "price",
        price: 8,
        interval: "month",
      },
      {
        type: "feature",
        feature_id: "sandbox_hours",
        included_usage: 6,
        interval: "month",
      },
      {
        type: "feature",
        feature_id: "tokens_in",
        included_usage: 1_500_000,
        interval: "month",
      },
      {
        type: "feature",
        feature_id: "tokens_out",
        included_usage: 300_000,
        interval: "month",
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
      name: "Pro",
      description: "For solo developers doing ongoing codebase research",
      button_text: "Upgrade to Pro",
    },
  },
] as const satisfies readonly Product[];

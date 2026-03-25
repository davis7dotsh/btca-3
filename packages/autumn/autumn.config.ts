import { feature, item, plan } from "atmn";

import { AUTUMN_FREE_PLAN, AUTUMN_PRO_PLAN, AUTUMN_USAGE_FEATURE } from "./src/config.ts";

export const usageUsd = feature({
  id: AUTUMN_USAGE_FEATURE.id,
  name: AUTUMN_USAGE_FEATURE.name,
  type: AUTUMN_USAGE_FEATURE.type,
  consumable: AUTUMN_USAGE_FEATURE.consumable,
});

export const freePlan = plan({
  id: AUTUMN_FREE_PLAN.id,
  name: AUTUMN_FREE_PLAN.name,
  autoEnable: AUTUMN_FREE_PLAN.autoEnable,
  items: [
    item({
      featureId: usageUsd.id,
      included: AUTUMN_FREE_PLAN.includedUsageUsd,
      reset: {
        interval: "one_off",
      },
    }),
  ],
});

export const proPlan = plan({
  id: AUTUMN_PRO_PLAN.id,
  name: AUTUMN_PRO_PLAN.name,
  price: {
    amount: AUTUMN_PRO_PLAN.priceUsd,
    interval: AUTUMN_PRO_PLAN.interval,
  },
  items: [
    item({
      featureId: usageUsd.id,
      included: AUTUMN_PRO_PLAN.includedUsageUsd,
      reset: {
        interval: AUTUMN_PRO_PLAN.interval,
      },
    }),
  ],
});

export type Feature = import("atmn").Feature;

export type Plan = import("atmn").Plan;

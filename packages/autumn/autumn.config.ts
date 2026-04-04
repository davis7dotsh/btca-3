import { feature, item, plan } from "atmn";

import { AUTUMN_FREE_PLAN, AUTUMN_PRO_PLAN, AUTUMN_USAGE_FEATURE } from "./src/config.ts";


// Features
export const sandbox_hours = feature({
	id: 'sandbox_hours',
	name: 'Sandbox Hours',
	type: 'metered',
	consumable: true,
});

export const tokens_out = feature({
	id: 'tokens_out',
	name: 'Tokens Out',
	type: 'metered',
	consumable: true,
});

export const tokens_in = feature({
	id: 'tokens_in',
	name: 'Tokens In',
	type: 'metered',
	consumable: true,
});

export const chat_messages = feature({
	id: 'chat_messages',
	name: 'Chat Messages',
	type: 'metered',
	consumable: true,
});

export const ai_budget = feature({
	id: 'ai_budget',
	name: 'AI Budget',
	type: 'metered',
	consumable: true,
});


// Plans
export const free_plan = plan({
	id: 'free_plan',
	name: 'Free Plan',
	autoEnable: true,
	items: [
		item({
			featureId: chat_messages.id,
			included: 5,
			reset: {
				interval: 'one_off',
			},
		}),
	],
});

export const btca_pro = plan({
	id: 'btca_pro',
	name: 'Pro Plan',
	price: {
		amount: 8,
		interval: 'month',
	},
	items: [
		item({
			featureId: ai_budget.id,
			included: 5000000,
			reset: {
				interval: 'month',
			},
		}),
	],
});
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

import { feature, item, plan } from "atmn";

// Features
export const tokens_in = feature({
  id: "tokens_in",
  name: "Tokens In",
  type: "metered",
  consumable: true,
});

export const chat_messages = feature({
  id: "chat_messages",
  name: "Chat Messages",
  type: "metered",
  consumable: true,
});

export const ai_budget = feature({
  id: "ai_budget",
  name: "AI Budget",
  type: "metered",
  consumable: true,
});

export const sandbox_hours = feature({
  id: "sandbox_hours",
  name: "Sandbox Hours",
  type: "metered",
  consumable: true,
});

export const tokens_out = feature({
  id: "tokens_out",
  name: "Tokens Out",
  type: "metered",
  consumable: true,
});

export const usage_usd = feature({
  id: "usage_usd",
  name: "Usage Wallet",
  type: "metered",
  consumable: true,
});

// Plans
export const free_plan = plan({
  id: "free_plan",
  name: "Free Plan",
  autoEnable: true,
  items: [
    item({
      featureId: usage_usd.id,
      included: 1,
      reset: {
        interval: "one_off",
      },
    }),
  ],
});

export const btca_pro = plan({
  id: "btca_pro",
  name: "Pro Plan",
  price: {
    amount: 8,
    interval: "month",
  },
  items: [
    item({
      featureId: usage_usd.id,
      included: 6,
      reset: {
        interval: "month",
      },
    }),
  ],
});

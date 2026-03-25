import { authedQuery } from "./helpers";

export const authedDemoQuery = authedQuery({
  args: {},
  handler: async (ctx) => {
    return {
      message: `Hello, ${ctx.identity.email ?? ctx.identity.subject}!`,
    };
  },
});

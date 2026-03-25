import { command, getRequestEvent } from "$app/server";
import { Effect } from "effect";
import { z } from "zod";
import { effectRunner } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";
import { BoxService } from "$lib/services/box";

const runBoxPrototypeInputSchema = z.object({
  threadId: z.string().min(1),
  boxId: z.string().min(1).optional(),
  prompt: z.string().min(1),
});

const runBoxPrototypeEffect = (input: z.infer<typeof runBoxPrototypeInputSchema>) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const box = yield* BoxService;
    const event = getRequestEvent();
    const user = yield* auth.validateSession(event);

    console.log("Running Box prototype command", {
      userId: user.userId,
      threadId: input.threadId,
      boxId: input.boxId ?? null,
    });

    return yield* box.runThreadAgent(input);
  });

export const runBoxPrototype = command(runBoxPrototypeInputSchema, async (input) => {
  return await effectRunner(runBoxPrototypeEffect(input));
});

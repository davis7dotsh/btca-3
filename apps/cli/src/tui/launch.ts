import * as Effect from "effect/Effect";
import { Server } from "../server.ts";

declare global {
  var __BTCA_TUI_CONTEXT__:
    | {
        readonly baseUrl: string;
        readonly version: string;
        readonly provider: string;
        readonly model: string;
        readonly debug: boolean;
      }
    | undefined;
}

export const launchTui = ({ version }: { version: string }) =>
  Effect.gen(function* () {
    const server = yield* Server;
    const config = yield* server.getConfig();

    globalThis.__BTCA_TUI_CONTEXT__ = {
      baseUrl: server.baseUrl,
      version,
      provider: config.model.provider,
      model: config.model.model,
      debug: !server.quiet,
    };

    yield* Effect.tryPromise(async () => {
      const module = await import("./App.tsx");
      await module.runTui();
    });
  });

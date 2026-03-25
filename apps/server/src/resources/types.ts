import type * as Effect from "effect/Effect";

import type { ResourceDefinition } from "../config.ts";

export type LoadedResource = {
  readonly kind: ResourceDefinition["type"];
  readonly name: string;
  readonly definition: ResourceDefinition;
  readonly instructions: string[];
  readonly materialize: (args: { targetDir: string }) => Effect.Effect<
    {
      mountPath: string;
    },
    Error
  >;
};

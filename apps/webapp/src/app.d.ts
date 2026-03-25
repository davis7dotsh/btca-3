// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    interface Error {
      readonly message: string;
      readonly kind: string;
      readonly timestamp: number;
      readonly traceId?: string;
    }
  }
}

export {};

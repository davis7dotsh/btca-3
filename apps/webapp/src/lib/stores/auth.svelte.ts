import { createContext, onMount } from "svelte";
import { getHumanErrorMessage } from "$lib/errors";

const toAuthErrorMessage = (error: unknown) =>
  getHumanErrorMessage(error, "Failed to load the current session.");

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly profilePictureUrl: string | null;
}

interface AuthStoreBootstrap {
  readonly user: AuthUser | null;
}

class AuthStore {
  status = $state<"loading" | "authenticated" | "unauthenticated">("loading");
  currentUser = $state<AuthUser | null>(null);
  errorMessage = $state<string | null>(null);

  constructor(initialState?: AuthStoreBootstrap) {
    if (initialState) {
      this.status = initialState.user ? "authenticated" : "unauthenticated";
      this.currentUser = initialState.user;
      this.errorMessage = null;
      return;
    }

    onMount(() => {
      void this.refreshSession();
    });
  }

  get isLoaded() {
    return this.status !== "loading";
  }

  async refreshSession() {
    try {
      const response = await fetch("/auth/session", {
        headers: {
          accept: "application/json",
        },
        cache: "no-store",
      });

      if (response.status === 401) {
        this.status = "unauthenticated";
        this.currentUser = null;
        this.errorMessage = null;
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? "Failed to load the current session.");
      }

      const data = (await response.json()) as {
        authenticated: true;
        user: AuthUser;
      };

      this.status = "authenticated";
      this.currentUser = data.user;
      this.errorMessage = null;
    } catch (error) {
      this.status = "unauthenticated";
      this.currentUser = null;
      this.errorMessage = toAuthErrorMessage(error);
      console.error("Error loading auth session", error);
    }
  }
}

const [internalGetAuthContext, setInternalGetAuthContext] = createContext<AuthStore>();

export function getAuthContext() {
  const authContext = internalGetAuthContext();

  if (!authContext) {
    throw new Error("Auth context not found");
  }

  return authContext;
}

export function setAuthContext(initialState?: AuthStoreBootstrap) {
  const authContext = new AuthStore(initialState);
  setInternalGetAuthContext(authContext);
  return authContext;
}

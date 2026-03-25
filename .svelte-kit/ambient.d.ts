// this file is generated — do not edit it

/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 *
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 *
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 *
 * **_Private_ access:**
 *
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 *
 * For example, given the following build time environment:
 *
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 *
 * With the default `publicPrefix` and `privatePrefix`:
 *
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 *
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 *
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module "$env/static/private" {
  export const CLERK_JWT_ISSUER_DOMAIN: string;
  export const CLERK_SECRET_KEY: string;
  export const CONVEX_DEPLOYMENT: string;
  export const CONVEX_PRIVATE_BRIDGE_KEY: string;
  export const DAYTONA_AGENT_SNAPSHOT: string;
  export const DAYTONA_API_KEY: string;
  export const DAYTONA_API_URL: string;
  export const EXA_API_KEY: string;
  export const OPENAI_API_KEY: string;
  export const OPENCODE_API_KEY: string;
  export const UPSTASH_BOX_API_KEY: string;
  export const WORKOS_API_KEY: string;
  export const WORKOS_AUTHKIT_DOMAIN: string;
  export const WORKOS_CLIENT_ID: string;
  export const WORKOS_COOKIE_PASSWORD: string;
  export const NVM_INC: string;
  export const T3CODE_DESKTOP_WS_URL: string;
  export const STARSHIP_SHELL: string;
  export const NVM_CD_FLAGS: string;
  export const TERM: string;
  export const SHELL: string;
  export const TMPDIR: string;
  export const MallocNanoZone: string;
  export const NO_COLOR: string;
  export const ZSH: string;
  export const LC_ALL: string;
  export const NVM_DIR: string;
  export const USER: string;
  export const LS_COLORS: string;
  export const T3CODE_MODE: string;
  export const COMMAND_MODE: string;
  export const SSH_AUTH_SOCK: string;
  export const BTCA_API_KEY: string;
  export const __CF_USER_TEXT_ENCODING: string;
  export const VITE_PLUS_TOOL_RECURSION: string;
  export const PAGER: string;
  export const ELECTRON_RUN_AS_NODE: string;
  export const npm_config_verify_deps_before_run: string;
  export const LSCOLORS: string;
  export const PATH: string;
  export const LaunchInstanceID: string;
  export const __CFBundleIdentifier: string;
  export const CODEX_THREAD_ID: string;
  export const npm_command: string;
  export const PWD: string;
  export const LANG: string;
  export const NODE_PATH: string;
  export const XPC_FLAGS: string;
  export const CODEX_CI: string;
  export const npm_config_manage_package_manager_versions: string;
  export const GREPTILE_API_KEY: string;
  export const pnpm_config_verify_deps_before_run: string;
  export const XPC_SERVICE_NAME: string;
  export const CODEX_MANAGED_BY_BUN: string;
  export const SHLVL: string;
  export const HOME: string;
  export const T3CODE_PORT: string;
  export const T3CODE_HOME: string;
  export const GH_PAGER: string;
  export const STARSHIP_SESSION_KEY: string;
  export const LESS: string;
  export const T3CODE_NO_BROWSER: string;
  export const LOGNAME: string;
  export const PNPM_PACKAGE_NAME: string;
  export const LC_CTYPE: string;
  export const NVM_BIN: string;
  export const BUN_INSTALL: string;
  export const npm_config_user_agent: string;
  export const T3CODE_AUTH_TOKEN: string;
  export const OSLogRateLimit: string;
  export const GIT_PAGER: string;
  export const SECURITYSESSIONID: string;
  export const COLORTERM: string;
  export const NODE_ENV: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 *
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 *
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 *
 * **_Public_ access:**
 *
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 *
 * For example, given the following build time environment:
 *
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 *
 * With the default `publicPrefix` and `privatePrefix`:
 *
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 *
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 *
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module "$env/static/public" {
  export const PUBLIC_CLERK_PUBLISHABLE_KEY: string;
  export const PUBLIC_CONVEX_SITE_URL: string;
  export const PUBLIC_CONVEX_URL: string;
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 *
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 *
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 *
 * **_Private_ access:**
 *
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 *
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 *
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 *
 * For example, given the following runtime environment:
 *
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 *
 * With the default `publicPrefix` and `privatePrefix`:
 *
 * ```ts
 * import { env } from '$env/dynamic/private';
 *
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module "$env/dynamic/private" {
  export const env: {
    CLERK_JWT_ISSUER_DOMAIN: string;
    CLERK_SECRET_KEY: string;
    CONVEX_DEPLOYMENT: string;
    CONVEX_PRIVATE_BRIDGE_KEY: string;
    DAYTONA_AGENT_SNAPSHOT: string;
    DAYTONA_API_KEY: string;
    DAYTONA_API_URL: string;
    EXA_API_KEY: string;
    OPENAI_API_KEY: string;
    OPENCODE_API_KEY: string;
    UPSTASH_BOX_API_KEY: string;
    WORKOS_API_KEY: string;
    WORKOS_AUTHKIT_DOMAIN: string;
    WORKOS_CLIENT_ID: string;
    WORKOS_COOKIE_PASSWORD: string;
    NVM_INC: string;
    T3CODE_DESKTOP_WS_URL: string;
    STARSHIP_SHELL: string;
    NVM_CD_FLAGS: string;
    TERM: string;
    SHELL: string;
    TMPDIR: string;
    MallocNanoZone: string;
    NO_COLOR: string;
    ZSH: string;
    LC_ALL: string;
    NVM_DIR: string;
    USER: string;
    LS_COLORS: string;
    T3CODE_MODE: string;
    COMMAND_MODE: string;
    SSH_AUTH_SOCK: string;
    BTCA_API_KEY: string;
    __CF_USER_TEXT_ENCODING: string;
    VITE_PLUS_TOOL_RECURSION: string;
    PAGER: string;
    ELECTRON_RUN_AS_NODE: string;
    npm_config_verify_deps_before_run: string;
    LSCOLORS: string;
    PATH: string;
    LaunchInstanceID: string;
    __CFBundleIdentifier: string;
    CODEX_THREAD_ID: string;
    npm_command: string;
    PWD: string;
    LANG: string;
    NODE_PATH: string;
    XPC_FLAGS: string;
    CODEX_CI: string;
    npm_config_manage_package_manager_versions: string;
    GREPTILE_API_KEY: string;
    pnpm_config_verify_deps_before_run: string;
    XPC_SERVICE_NAME: string;
    CODEX_MANAGED_BY_BUN: string;
    SHLVL: string;
    HOME: string;
    T3CODE_PORT: string;
    T3CODE_HOME: string;
    GH_PAGER: string;
    STARSHIP_SESSION_KEY: string;
    LESS: string;
    T3CODE_NO_BROWSER: string;
    LOGNAME: string;
    PNPM_PACKAGE_NAME: string;
    LC_CTYPE: string;
    NVM_BIN: string;
    BUN_INSTALL: string;
    npm_config_user_agent: string;
    T3CODE_AUTH_TOKEN: string;
    OSLogRateLimit: string;
    GIT_PAGER: string;
    SECURITYSESSIONID: string;
    COLORTERM: string;
    NODE_ENV: string;
    [key: `PUBLIC_${string}`]: undefined;
    [key: `${string}`]: string | undefined;
  };
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 *
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 *
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 *
 * **_Public_ access:**
 *
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 *
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 *
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 *
 * For example, given the following runtime environment:
 *
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 *
 * With the default `publicPrefix` and `privatePrefix`:
 *
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 *
 * ```
 *
 * ```
 */
declare module "$env/dynamic/public" {
  export const env: {
    PUBLIC_CLERK_PUBLISHABLE_KEY: string;
    PUBLIC_CONVEX_SITE_URL: string;
    PUBLIC_CONVEX_URL: string;
    [key: `PUBLIC_${string}`]: string | undefined;
  };
}

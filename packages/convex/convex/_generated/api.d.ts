/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as authed_agentThreads from "../authed/agentThreads.js";
import type * as authed_conferences from "../authed/conferences.js";
import type * as authed_demo from "../authed/demo.js";
import type * as authed_helpers from "../authed/helpers.js";
import type * as authed_resources from "../authed/resources.js";
import type * as private_agentThreads from "../private/agentThreads.js";
import type * as private_demo from "../private/demo.js";
import type * as private_helpers from "../private/helpers.js";
import type * as private_identityLinks from "../private/identityLinks.js";
import type * as private_resources from "../private/resources.js";
import type * as resourceHelpers from "../resourceHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "authed/agentThreads": typeof authed_agentThreads;
  "authed/conferences": typeof authed_conferences;
  "authed/demo": typeof authed_demo;
  "authed/helpers": typeof authed_helpers;
  "authed/resources": typeof authed_resources;
  "private/agentThreads": typeof private_agentThreads;
  "private/demo": typeof private_demo;
  "private/helpers": typeof private_helpers;
  "private/identityLinks": typeof private_identityLinks;
  "private/resources": typeof private_resources;
  resourceHelpers: typeof resourceHelpers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

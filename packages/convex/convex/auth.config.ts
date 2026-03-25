import type { AuthConfig } from "convex/server";

const workosClientId = process.env.WORKOS_CLIENT_ID;

if (!workosClientId) {
  throw new Error("Missing WORKOS_CLIENT_ID for Convex auth config");
}

export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://api.workos.com/",
      jwks: `https://api.workos.com/sso/jwks/${workosClientId}`,
      applicationID: workosClientId,
      algorithm: "RS256",
    },
    {
      type: "customJwt",
      issuer: `https://api.workos.com/user_management/${workosClientId}`,
      jwks: `https://api.workos.com/sso/jwks/${workosClientId}`,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;

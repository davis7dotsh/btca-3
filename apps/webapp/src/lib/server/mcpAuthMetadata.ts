import { env as privateEnv } from "$env/dynamic/private";

const MCP_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

const getRequiredValue = (name: string) => {
  const value = privateEnv[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const getRequiredUrl = (name: string) => new URL(getRequiredValue(name));

export const getAuthkitDomain = () => getRequiredUrl("WORKOS_AUTHKIT_DOMAIN");

export const getMcpPublicOrigin = (request: Request) =>
  new URL(privateEnv.MCP_PUBLIC_URL ?? request.url).origin;

export const getMcpEndpointUrl = (request: Request) =>
  new URL("/api/mcp", getMcpPublicOrigin(request)).href;

export const getProtectedResourceMetadataUrl = (request: Request) =>
  new URL("/.well-known/oauth-protected-resource", getMcpPublicOrigin(request)).href;

export const getAuthorizationServerMetadataUrl = (request: Request) =>
  new URL("/.well-known/oauth-authorization-server", getMcpPublicOrigin(request)).href;

export const buildAuthorizationServerMetadata = (_request: Request) => {
  const authkitDomain = getAuthkitDomain();

  return {
    issuer: authkitDomain.origin,
    authorization_endpoint: new URL("/oauth2/authorize", authkitDomain).href,
    token_endpoint: new URL("/oauth2/token", authkitDomain).href,
    registration_endpoint: new URL("/oauth2/register", authkitDomain).href,
    jwks_uri: new URL("/oauth2/jwks", authkitDomain).href,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...MCP_SCOPES],
  };
};

export const buildProtectedResourceMetadata = (request: Request) => ({
  resource: getMcpEndpointUrl(request),
  authorization_servers: [getAuthkitDomain().origin],
  bearer_methods_supported: ["header"],
  scopes_supported: [...MCP_SCOPES],
  resource_documentation: new URL("/app/mcp/getting-started", getMcpPublicOrigin(request)).href,
});

import fs from "node:fs";

import express, { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import helmet from "helmet";
import * as undici from "undici";
import * as openid from "openid-client";
import jwt from "jsonwebtoken";

import { createConfiguration, Configuration } from "./configuration";
import { logger } from "./logger";

(async function main() {
  const configuration = createConfiguration();
  const oidcConfiguration = await createOidcConfiguration(configuration);
  const application = createHttp(configuration, oidcConfiguration);
  startHttp(configuration, application);
})();

async function createOidcConfiguration(
  configuration: Configuration,
): Promise<openid.Configuration> {

  // Create mTLS agent with client certificate that is send to the server.
  const agent = new undici.Agent({
    connect: {
      key: fs.readFileSync(configuration.caais.certificate.keyPath),
      cert: fs.readFileSync(configuration.caais.certificate.path),
      passphrase: configuration.caais.certificate.passphrase,
    }
  });

  const oidcClient = await openid.discovery(
    new URL(configuration.caais.hostUrl),
    configuration.caais.clientId,
  );

  // Configure custom fetch using our client with certificates.
  oidcClient[openid.customFetch] = // @ts-ignore
    (...args) => undici.fetch(args[0], { ...args[1], dispatcher: agent });

  return oidcClient;
}

function createHttp(
  configuration: Configuration,
  oidcClient: openid.Configuration,
): Express {
  const application = express();

  // Apply security headers via helmet.
  application.use(helmet());

  configureSession(configuration, application);

  application.get("/login", (req, res) => withErrorHandling(res,
    () => handleLogin(configuration, oidcClient, req, res)));

  application.get("/callback", (req, res) => withErrorHandling(res,
    () => handleCaaisCallback(configuration, oidcClient, req, res)));

  application.get("/logout", (req, res) => withErrorHandling(res,
    () => handleLogout(configuration, oidcClient, req, res)));

  application.get("/authenticate", (req, res) => withErrorHandling(res,
    () => handleAuthenticate(configuration, oidcClient, req, res)));

  return application;
}

function configureSession(configuration: Configuration, application: Express) {

  // We need this for session.cookies.secure === true.
  // application.set("trust proxy", 1);
  // TODO : We need some NginX configuration see https://expressjs.com/en/guide/behind-proxies.html

  application.use(session({
    name: configuration.http.cookieName,
    secret: configuration.http.cookiesSecret,
    resave: false,
    // Only save session when it has been modified (not on every request).
    // This prevents session store flooding and avoids creating tracking
    // cookies for unauthenticated requests.
    saveUninitialized: false,
    cookie: {
      maxAge: 60 * 60 * 1000, // One hour.
      httpOnly: true,
      secure: false,
      // Restrict cross-site cookie sending to mitigate CSRF.
      sameSite: "lax",
    },
  }));

  // Creates default session object.
  application.use((request, _response, next: NextFunction) => {
    const session = request.session as any;
    if (session.caais === undefined) {
      createSessionData(session);
    }
    next();
  });

}

function createSessionData(session: session.SessionData): void {
  session.caais = {
    authenticated: false,
  };
  session.headers = {};
}

declare module "express-session" {
  interface SessionData {
    caais: {
      authenticated: boolean,
      expiresAt?: number,
      idToken?: string,
      refreshToken?: string,
      // Used for login.
      codeVerifier?: string,
      state?: string,
      nonce?: string,
      redirectUrl?: string,
    },
    headers: { [name: string]: string },
  }
}

/**
 * Validates that a redirect URL is safe, relative path or same-origin.
 * Returns the sanitized URL, or an empty string if the URL is unsafe.
 */
function sanitizeRedirectUrl(raw: string | undefined): string {
  if (raw === undefined || raw === "undefined") {
    return "";
  }
  // Allow only relative paths starting with '/'.
  if (/^\/[^/\\]/.test(raw) || raw === "/") {
    return raw;
  }
  return "";
}

async function withErrorHandling(
  response: Response,
  fnc: () => Promise<void>,
) {
  try {
    await fnc();
  } catch (error) {
    response.status(500).send();
  }
}

async function handleLogin(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  const session = request.session as session.SessionData;
  logger.trace({session: request.sessionID}, "/login");

  // Generate code verifier for PKCE and store it in the session.
  const codeVerifier = openid.randomPKCECodeVerifier();
  const codeChallenge = await openid.calculatePKCECodeChallenge(codeVerifier);
  session.caais.codeVerifier = codeVerifier;

  // Generate state for CSRF protection and store it in the session.
  const state = openid.randomState();
  session.caais.state = state;

  // Generate nonce and store it in the session.
  const nonce = openid.randomNonce();
  session.caais.nonce = nonce;

  // Store redirect url - only allow safe relative paths to prevent open redirect.
  const rawRedirect = request.query["redirect-url"];
  session.caais.redirectUrl = sanitizeRedirectUrl(
    Array.isArray(rawRedirect) ? String(rawRedirect[0]) : String(rawRedirect)
  );

  // Build authorization URL
  const authUrl = openid.buildAuthorizationUrl(oidcClient, {
    scope: "openid profile subject role",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: state,
    redirect_uri: configuration.caais.callbackUrl,
    nonce: nonce,
  });

  // Redirect use to the CAAIS login page.
  response.redirect(authUrl.href);
}

async function handleCaaisCallback(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  logger.trace({session: request.sessionID}, "/callback");

  const session = request.session as session.SessionData;
  const currentUrl = new URL(
    configuration.caais.callbackUrl +
    request.url.substring(request.url.indexOf("?")));

  // Exchange authorization code for tokens.
  const tokens = await openid.authorizationCodeGrant(
    oidcClient, currentUrl,
    {
      pkceCodeVerifier: session.caais.codeVerifier,
      expectedState: session.caais.state,
      expectedNonce: session.caais.nonce,
    },
  );

  // TODO : Check we have the tokens.

  const userInfo = await openid.fetchUserInfo(
    oidcClient,
    tokens.access_token,
    tokens.claims()?.sub,  // Verify subject claim matches the token
  );

  // Update state.
  session.caais.authenticated = true;
  session.caais.idToken = tokens.id_token;
  session.caais.refreshToken = tokens.refresh_token;
  session.caais.expiresAt = tokens.expires_in
    ? Math.floor(Date.now() / 1000) + tokens.expires_in
    : undefined;

  session.headers["x-caais-token"] = jwt.sign(
    createToken(userInfo), configuration.token.tokenSignSecret,
    { algorithm: "HS256" },
  );

  // Redirect back to the original page (already sanitized at login time).
  const redirectUrl = session.caais.redirectUrl || "/";
  response.redirect(redirectUrl);
}

function createToken(userInfo: openid.UserInfoResponse) {
  return {
    authenticated: true,
    user: {
      username: userInfo.username,
      family_name: userInfo.family_name,
      given_name: userInfo.given_name,
      activity_role_codes: (userInfo.activity_roles as any)
        ?.map((item: any) => item.activity_role_codes ?? [])
        .flat(),
    },
    entity: {
      public_identifier: userInfo.public_organization_identifier,
      name: userInfo.legal_entity_name,
    }
  }
}

async function handleLogout(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  logger.trace({session: request.sessionID}, "/logout");

  // We grab copy of the session here and clear the session.
  // This performs logout in our application no matter what.
  const { caais } = request.session as session.SessionData;
  clearSessionData(request.session as any);

  // Was user actually logged in?
  if (caais.authenticated !== true) {
    response.send();
    return;
  }

  // If there is no support for end session endpoint, just clear session.
  const serverMetadata = oidcClient.serverMetadata();
  if (serverMetadata.end_session_endpoint === undefined) {
    response.send();
    return;
  }

  // Redirect to logout endpoint.
  const logoutUrl = new URL(serverMetadata.end_session_endpoint);
  logoutUrl.searchParams.set("id_token_hint", caais.idToken!);
  logoutUrl.searchParams.set("post_logout_redirect_uri",
    configuration.caais.callbackUrl);
  logoutUrl.searchParams.set("client_id", configuration.caais.clientId);
  // Generate a fresh state for the logout request rather than reusing the
  // login state which may have already been consumed or invalidated.
  logoutUrl.searchParams.set("state", openid.randomState());
  return response.redirect(logoutUrl.href);
}

function clearSessionData(session: session.SessionData): void {
  session.caais = {
    authenticated: false,
  };
  session.headers = {};
}

async function handleAuthenticate(
  _configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  const { caais, headers } = request.session as session.SessionData;

  if (caais.authenticated !== true) {
    logger.trace(
      {session: request.sessionID},
      "/authenticate 401 : Not authenticated");
    response.status(401).send();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if (caais.expiresAt && caais.expiresAt < now) {
    logger.trace(
      {session: request.sessionID},
      "/authenticate 401 : Refreshing token");
    try {
      const newTokens = await refreshAccessToken(oidcClient, caais.refreshToken!);
      // Store refreshed tokens in the session.
      caais.refreshToken = newTokens.refresh_token ?? caais.refreshToken;
      caais.idToken = newTokens.id_token ?? caais.idToken;
      caais.expiresAt = newTokens.expires_in
        ? Math.floor(Date.now() / 1000) + newTokens.expires_in
        : caais.expiresAt;
    } catch (error) {
      // Token refresh failed; clear session and report unauthenticated.
      clearSessionData(request.session as any);
      logger.trace(
        {session: request.sessionID},
        "/authenticate 401 : Token expired");
      response.status(401).send();
      return;
    }
  }

  // Send headers to the client.
  for (const [name, value] of Object.entries(headers)) {
    response.header(name, value);
  }
  logger.trace({session: request.sessionID}, "/authenticate 200");
  response.send();
}

async function refreshAccessToken(
  oidcClient: openid.Configuration,
  refreshToken: string,
): Promise<openid.TokenEndpointResponse & openid.TokenEndpointResponseHelpers> {
  try {
    const tokens = await openid.refreshTokenGrant(oidcClient, refreshToken);
    return tokens;
  } catch (error) {
    logger.error(error, "Failed to refresh token.");
    throw error;
  }
}

function startHttp(configuration: Configuration, application: Express): void {
  const port = configuration.http.port;
  application.listen(port, () => {
    logger.info({ host: `http://localhost:${port}/` }, "Server is running.");
  });
}

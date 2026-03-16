import fs from "node:fs";

import express, { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import * as undici from "undici";
import * as openid from "openid-client";

import { createConfiguration, Configuration } from "./configuration";

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
  configureSession(configuration, application);

  application.get("/", (req, res) => {
    res.send("CAAIS is listening.");
  });

  application.get("/login",
    (req, res) => {
      console.log("/login");
      handleLogin(configuration, oidcClient, req, res)
    });
  application.get("/callback",
    (req, res) => {
      console.log("/callback");
      handleCaaisCallback(configuration, oidcClient, req, res)
    });
  application.get("/logout",
    (req, res) => {
      console.log("/logout");
      handleLogout(configuration, oidcClient, req, res)
    });
  application.get("/authenticate",
    (req, res) => {
      console.log("/authenticate");
      handleAuthenticate(configuration, oidcClient, req, res)
    });

  // TODO : Handle 404 codes.

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
    saveUninitialized: true,
    cookie: {
      maxAge: 60 * 60 * 1000, // One hour.
      httpOnly: true,
      secure: false,
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

async function handleLogin(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  const session = request.session as session.SessionData;

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

  // Store redirect url.
  // TODO We need a reasonable callback URL as a default.
  session.caais.redirectUrl = String(request.query["redirect-url"]) ?? "";

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

/**
 * TODO: Handle logout callback.
 */
async function handleCaaisCallback(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  const session = request.session as session.SessionData;

  // TODO : We need to construct request URL here.
  const currentUrl = new URL(configuration.caais.callbackUrl + request.url.substring(request.url.indexOf("?")));

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
    //tokens.sub  // Add the subject from the token
    openid.skipSubjectCheck // decodedPayload.sub
  );

  // Update state.
  session.caais.authenticated = true;
  session.caais.idToken = tokens.id_token;
  session.caais.refreshToken = tokens.refresh_token;

  session.headers["x-caais-token"]= JSON.stringify({
    authenticated: true,
    user: {
      username: userInfo.username,
      family_name: userInfo.family_name,
      given_name: userInfo.given_name,
      roles: (userInfo.access_roles as any)
        ?.map((item: any) => item.access_role_code) ?? [],
    },
    entity: {
      public_identifier: userInfo.public_organization_identifier,
      name: userInfo.legal_entity_name,
    }
  });

  // Redirect back to the original page.
  response.redirect(session.caais.redirectUrl!);
}

function handleLogout(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): void {
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
  logoutUrl.searchParams.set("state", caais.state!);
  return response.redirect(logoutUrl.href);
}

function clearSessionData(session: session.SessionData): void {
  session.caais = {
    authenticated: false,
  };
  session.headers = {};
}

async function handleAuthenticate(
  configuration: Configuration,
  oidcClient: openid.Configuration,
  request: Request,
  response: Response,
): Promise<void> {
  const { caais, headers } = request.session as session.SessionData;

  if (caais.authenticated !== true) {
    // User is not authenticated.
    response.header("x-caais-token", JSON.stringify({
      authenticated: false,
    }));
    response.send();
  }

  const now = Math.floor(Date.now() / 1000);
  if (caais.expiresAt && caais.expiresAt < now + 300) {
    const newTokens = await refreshAccessToken(oidcClient, caais.refreshToken!);
    // TODO Store new tokens ...
  }

  // Send headers to the client.
  for (const [name, value] of Object.entries(headers)) {
    response.header(name, value);
  }
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
    console.error("Failed to refresh token:", error);
    throw error;
  }
}

function startHttp(configuration: Configuration, application: Express): void {
  const port = configuration.http.port;
  application.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}/`);
  });
}

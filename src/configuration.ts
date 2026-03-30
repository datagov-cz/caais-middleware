import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

// Load values from .env file and put them into process.env.
dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

const ConfigurationSchema = z.object({
  /**
   * True when in a develop mode.
   */
  development: z.boolean(),
  /**
   * Configuration of this service HTTP interface.
   */
  http: z.object({
    /**
     * Port for the HTTP server to listen on.
     */
    port: z.number().positive(),
    /**
     * Name of cookie to send to the user.
     */
    cookieName: z.string(),
    /**
     * A secret with minimum length of 32 characters.
     * We use this to sign the cookies.
     */
    cookiesSecret: z.string().min(32),
  }),
  /**
   * CAAIS configuration.
   */
  caais: z.object({
    /**
     * Application identifier for CAAIS.
     */
    clientId: z.string(),
    /**
     * CAAIS server URL.
     */
    hostUrl: z.string().url(),
    /**
     * CAAIS callback redirect URL.
     */
    callbackUrl: z.string().url(),
    /**
     * Certificate.
     */
    certificate: z.object({
      /**
       * Path to a file with a client certificate.
       */
      path: z.string(),
      /**
       * Path to the client certificate private key file.
       */
      keyPath: z.string(),
      /**
       * Password for the certificate private key file.
       */
      passphrase: z.string(),
    }),
    /**
     * CAAIS login endpoint.
     * We redirect user to this endpoint for login
     */
    loginEndpointUrl: z.string().url(),
  }),
  token: z.object({
    /**
     * A secret with minimum length of 32 characters used to sign
     * the x-caais-token JWT header sent to downstream services.
     */
    tokenSignSecret: z.string().min(32),
  }),
});

export type Configuration = z.infer<typeof ConfigurationSchema>;

export const createConfiguration = (): Configuration => {
  const env = process.env;
  return ConfigurationSchema.parse({
    development: env.NODE_ENV === "development",
    http: {
      port: Number(env.HTTP_PORT),
      cookieName: env.HTTP_COOKIE_NAME,
      cookiesSecret: env.HTTP_COOKIE_SECRET,
    },
    caais: {
      clientId: env.CAAIS_CLIENT_ID,
      hostUrl: env.CAAIS_HOST,
      callbackUrl: env.CAAIS_CALLBACK_URL,
      certificate: {
        path: resolvePath(env.CAAIS_CERTIFICATE),
        keyPath: resolvePath(env.CAAIS_CERTIFICATE_KEY),
        passphrase: env.CAAIS_CERTIFICATE_PASSPHRASE,
      },
      loginEndpointUrl: env.CAAIS_LOGIN_ENDPOINT,
    },
    token: {
      tokenSignSecret: env.TOKEN_SIGN_SECRET,
    },
  });
};

function resolvePath(path: string | undefined): string | undefined {
  // We need to go from source directory.
  return path === undefined ? undefined : resolve(__dirname, "..", path);
}

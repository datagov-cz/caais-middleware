// https://github.com/pinojs/pino
import pino from "pino";
import { type LoggerOptions } from "pino";
import dotenv from "dotenv";

// Load environment variables into the process.env.
dotenv.config({ quiet: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoConfiguration: LoggerOptions = {
  // Set minimal logging level.
  level: process.env.LOG_LEVEL ?? "info",
  // Remove "pid" and "hostname" from a log message.
  base: null,
  // Output format configuration.
  formatters: {
    // Print log levels instead of numbers.
    level: (label) => ({ level: label }),
    // TODO Include version or other custom information.
    // bindings: () => { return { version: packageJson.version }; },
  },
  // Use ISO 8601-formatted time in UTC instead of epoch time.
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Add pretty print for development.
if (process.env.NODE_ENV === "development") {
  pinoConfiguration["transport"] = {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  };
}

export const logger = pino(pinoConfiguration);

// https://github.com/pinojs/pino
import pino from "pino";
import { type LoggerOptions } from "pino";

import { createConfiguration } from "./configuration";

// Prepare configuration
const configuration = createConfiguration();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoConfiguration: LoggerOptions = {
  level: configuration.log.level,
};

if (configuration.development) {
  // Add pretty print for development.
  pinoConfiguration["transport"] = {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  };
}

export const logger = pino(pinoConfiguration);

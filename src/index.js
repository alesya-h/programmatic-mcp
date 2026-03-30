#!/usr/bin/env node

import { SERVER_NAME } from "./constants.js";
import { main } from "./main.js";
import { getErrorMessage } from "./utils.js";

main().catch((error) => {
  console.error(`[${SERVER_NAME}] fatal error: ${getErrorMessage(error)}`);
  process.exit(1);
});

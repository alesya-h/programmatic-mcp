import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { inspect } from "node:util";

import { DEFAULT_DISCOVERY_TIMEOUT_MS, SERVER_NAME } from "./constants.js";
import { getErrorMessage } from "./utils.js";

export function resolveConfigPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, SERVER_NAME, "config.json");
}

function resolveDataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function resolveAuthStorePath() {
  return path.join(resolveDataHome(), SERVER_NAME, "oauth.json");
}

export async function loadResolvedConfig() {
  const configPath = resolveConfigPath();
  const configDirectory = path.dirname(configPath);
  const rawConfig = await readConfigFile(configPath);
  const parsedConfig = parseJsonConfig(rawConfig, configPath);
  const resolvedConfig = await substituteVariables(parsedConfig, configDirectory);
  return {
    configPath,
    resolvedConfig,
    serversConfig: getPlainObject(resolvedConfig.servers, 'Config field "servers"'),
    presetsConfig: getPlainObject(resolvedConfig.presets, 'Config field "presets"'),
  };
}

async function readConfigFile(configPath) {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Config file not found at ${configPath}.`);
    }
    throw error;
  }
}

function parseJsonConfig(rawConfig, configPath) {
  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`Failed to parse JSON config at ${configPath}: ${getErrorMessage(error)}`);
  }
}

async function substituteVariables(value, configDirectory) {
  if (typeof value === "string") {
    return substituteString(value, configDirectory);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => substituteVariables(item, configDirectory)));
  }

  if (value && typeof value === "object") {
    const object = {};
    for (const [key, childValue] of Object.entries(value)) {
      object[key] = await substituteVariables(childValue, configDirectory);
    }
    return object;
  }

  return value;
}

async function substituteString(value, configDirectory) {
  let nextValue = value
    .replaceAll(/\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? "")
    .replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_, name, _defaultClause, defaultValue) => {
      return process.env[name] ?? defaultValue ?? "";
    });
  const fileMatches = [...nextValue.matchAll(/\{file:([^}]+)\}/g)];

  for (const match of fileMatches) {
    const token = match[0];
    const filePath = resolveReferencedFile(match[1], configDirectory);
    const fileContents = await readFile(filePath, "utf8");
    nextValue = nextValue.replace(token, fileContents);
  }

  return nextValue;
}

function resolveReferencedFile(filePath, configDirectory) {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(configDirectory, filePath);
}

export function normalizePreset(presetName, presetConfig, serversConfig) {
  const presetSource =
    Array.isArray(presetConfig) || typeof presetConfig === "string"
      ? presetConfig
      : getPlainObject(presetConfig, `Preset "${presetName}"`).servers ?? presetConfig;

  const normalizedEntries = new Map();

  if (typeof presetSource === "string") {
    addPresetEntry(normalizedEntries, presetSource, true);
  } else if (Array.isArray(presetSource)) {
    for (const serverName of presetSource) {
      addPresetEntry(normalizedEntries, serverName, true);
    }
  } else {
    const presetObject = getPlainObject(presetSource, `Preset "${presetName}" servers`);
    for (const [serverName, rule] of Object.entries(presetObject)) {
      addPresetEntry(normalizedEntries, serverName, rule);
    }
  }

  for (const [serverName, entry] of normalizedEntries) {
    const serverConfig = parseServerConfig(serverName, serversConfig[serverName]);

    if (serverConfig.enabled === false && entry.presetEnabledOverride !== true) {
      normalizedEntries.delete(serverName);
      continue;
    }

    entry.serverConfig =
      entry.presetEnabledOverride === true ? { ...serverConfig, enabled: true } : serverConfig;
  }

  return normalizedEntries;
}

function addPresetEntry(target, serverName, rule) {
  if (typeof serverName !== "string" || !serverName) {
    throw new Error(`Preset contains an invalid server name: ${inspect(serverName)}`);
  }

  assertValidServerName(serverName);

  const toolPolicy = parseToolPolicy(serverName, rule);
  if (!toolPolicy) {
    return;
  }

  target.set(serverName, {
    name: serverName,
    toolPolicy,
    presetEnabledOverride: getPresetEnabledOverride(rule),
    serverConfig: undefined,
  });
}

function getPresetEnabledOverride(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return undefined;
  }

  const ruleObject = getPlainObject(rule, "Preset rule");
  return ruleObject.enabled === true ? true : undefined;
}

function parseServerConfig(serverName, config) {
  assertValidServerName(serverName);
  const serverConfig = getPlainObject(config, `Server "${serverName}" config`);
  const serverType = normalizeServerType(serverConfig.type, serverName);

  if (serverType === "local") {
    const command = normalizeCommand(serverConfig.command, serverConfig.args, serverName);

    return {
      type: "local",
      description: typeof serverConfig.description === "string" ? serverConfig.description : undefined,
      command,
      environment: normalizeEnvironmentMap(serverConfig, serverName),
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout,
      cwd: typeof serverConfig.cwd === "string" ? serverConfig.cwd : undefined,
      oauth: false,
    };
  }

  if (serverType === "remote") {
    if (typeof serverConfig.url !== "string" || !serverConfig.url) {
      throw new Error(`Remote server "${serverName}" must define a url.`);
    }

    return {
      type: "remote",
      transport: normalizeRemoteTransport(serverConfig.type),
      description: typeof serverConfig.description === "string" ? serverConfig.description : undefined,
      url: serverConfig.url,
      headers: normalizeStringMap(serverConfig.headers, `Server "${serverName}" headers`),
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout,
      oauth: normalizeOAuthConfig(serverConfig.oauth, serverName),
    };
  }

  throw new Error(
    `Server "${serverName}" must have type "local", "stdio", "remote", "http", or "sse", got ${inspect(serverConfig.type)}.`,
  );
}

function normalizeServerType(type, serverName) {
  if (type === "local" || type === "stdio") {
    return "local";
  }

  if (type === "remote" || type === "http" || type === "sse") {
    return "remote";
  }

  throw new Error(
    `Server "${serverName}" must have type "local", "stdio", "remote", "http", or "sse", got ${inspect(type)}.`,
  );
}

function normalizeRemoteTransport(type) {
  if (type === "sse") {
    return "sse";
  }

  return "http";
}

function normalizeCommand(command, args, serverName) {
  const normalizedArgs = normalizeCommandArgs(args, serverName);

  if (typeof command === "string" && command) {
    return [command, ...normalizedArgs];
  }

  if (Array.isArray(command) && command.length > 0) {
    return [...command.map((item) => String(item)), ...normalizedArgs];
  }

  throw new Error(
    `Local server "${serverName}" must define a command as a non-empty string or array.`,
  );
}

function normalizeCommandArgs(args, serverName) {
  if (args === undefined) {
    return [];
  }

  if (!Array.isArray(args)) {
    throw new Error(`Local server "${serverName}" args must be an array.`);
  }

  return args.map((item) => String(item));
}

function normalizeEnvironmentMap(serverConfig, serverName) {
  const env = normalizeStringMap(serverConfig.env, `Server "${serverName}" env`);
  const environment = normalizeStringMap(
    serverConfig.environment,
    `Server "${serverName}" environment`,
  );

  if (!env && !environment) {
    return undefined;
  }

  return {
    ...(env ?? {}),
    ...(environment ?? {}),
  };
}

function normalizeOAuthConfig(value, serverName) {
  if (value === false) {
    return false;
  }

  if (value === undefined || value === null) {
    return {
      enabled: true,
    };
  }

  if (value === true) {
    return {
      enabled: true,
    };
  }

  const oauth = getPlainObject(value, `Server "${serverName}" oauth`);
  return {
    enabled: true,
    clientId: typeof oauth.clientId === "string" ? oauth.clientId : undefined,
    clientSecret: typeof oauth.clientSecret === "string" ? oauth.clientSecret : undefined,
    scope: typeof oauth.scope === "string" ? oauth.scope : undefined,
  };
}

export function parseAllServers(serversConfig) {
  return new Map(
    Object.entries(serversConfig).map(([serverName, config]) => [serverName, parseServerConfig(serverName, config)]),
  );
}

function normalizeStringMap(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const object = getPlainObject(value, label);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, String(item)]));
}

function assertValidServerName(serverName) {
  if (!isValidJavaScriptIdentifier(serverName)) {
    throw new Error(
      `Server name "${serverName}" is invalid. Server names must be valid JavaScript identifiers so they can be used directly in execute_code.`,
    );
  }
}

function isValidJavaScriptIdentifier(value) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    return false;
  }

  try {
    new vm.Script(`const ${value} = null;`);
    return true;
  } catch {
    return false;
  }
}

function parseToolPolicy(serverName, rule) {
  if (rule === false) {
    return null;
  }

  if (rule === true || rule === undefined || rule === null) {
    return { mode: "all" };
  }

  if (typeof rule === "string") {
    return rule === "*" ? { mode: "all" } : { mode: "subset", tools: new Set([rule]) };
  }

  if (Array.isArray(rule)) {
    if (rule.includes("*")) {
      return { mode: "all" };
    }
    return { mode: "subset", tools: new Set(rule.map(String)) };
  }

  const ruleObject = getPlainObject(rule, `Preset rule for server "${serverName}"`);

  if (ruleObject.enabled === false) {
    return null;
  }

  if (ruleObject.tools === undefined || ruleObject.tools === true) {
    return { mode: "all" };
  }

  if (ruleObject.tools === "*" || ruleObject.tools === null) {
    return { mode: "all" };
  }

  if (typeof ruleObject.tools === "string") {
    return { mode: "subset", tools: new Set([ruleObject.tools]) };
  }

  if (Array.isArray(ruleObject.tools)) {
    if (ruleObject.tools.includes("*")) {
      return { mode: "all" };
    }
    return { mode: "subset", tools: new Set(ruleObject.tools.map(String)) };
  }

  throw new Error(
    `Preset rule for server "${serverName}" must use tools as "*" or an array of tool names.`,
  );
}

export function getPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function getDiscoveryTimeout(serverConfig) {
  return typeof serverConfig.timeout === "number"
    ? serverConfig.timeout
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

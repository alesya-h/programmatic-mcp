import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { inspect } from "node:util";
import { parse as parseYaml } from "yaml";

import { DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_PRESET, SERVER_NAME } from "./constants.js";
import { getErrorMessage } from "./utils.js";

const CONFIG_FILE_NAMES = ["config.json", "config.yaml", "config.yml"];
const DEFAULT_JSMCP_CONFIG = {
  autoStripToolPrefixes: false,
  normalizeToolNames: false,
};

export function resolveConfigDirectory() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, SERVER_NAME);
}

export function resolveApiKeyPath() {
  return path.join(resolveConfigDirectory(), "api-key.txt");
}

export async function resolveConfigPath() {
  const configDirectory = resolveConfigDirectory();
  const configPaths = await findConfigPaths(configDirectory);

  if (configPaths.length === 0) {
    throw new Error(
      `Config file not found in ${configDirectory}. Expected exactly one of: ${CONFIG_FILE_NAMES.join(", ")}.`,
    );
  }

  if (configPaths.length > 1) {
    throw new Error(
      `Multiple config files found in ${configDirectory}: ${configPaths.map((filePath) => path.basename(filePath)).join(", ")}. Keep exactly one config file.`,
    );
  }

  return configPaths[0];
}

function resolveDataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function resolveAuthStorePath() {
  return path.join(resolveDataHome(), SERVER_NAME, "oauth.json");
}

export async function loadResolvedConfig() {
  const configPath = await resolveConfigPath();
  const configDirectory = path.dirname(configPath);
  const rawConfig = await readConfigFile(configPath);
  const parsedConfig = parseConfig(rawConfig, configPath);
  const resolvedConfig = await substituteVariables(parsedConfig, configDirectory);
  return {
    configPath,
    resolvedConfig,
    jsmcpConfig: normalizeJsmcpConfig(resolvedConfig.jsmcp),
    serversConfig: getPlainObject(resolvedConfig.servers, 'Config field "servers"'),
    presetsConfig:
      resolvedConfig.presets === undefined
        ? undefined
        : getPlainObject(resolvedConfig.presets, 'Config field "presets"'),
  };
}

function normalizeJsmcpConfig(config) {
  if (config === undefined) {
    return { ...DEFAULT_JSMCP_CONFIG };
  }

  const object = getPlainObject(config, 'Config field "jsmcp"');
  return {
    autoStripToolPrefixes: normalizeOptionalBoolean(
      object.auto_strip_tool_prefixes,
      'Config field "jsmcp.auto_strip_tool_prefixes"',
    ) ?? DEFAULT_JSMCP_CONFIG.autoStripToolPrefixes,
    normalizeToolNames: normalizeOptionalBoolean(
      object.normalize_tool_names,
      'Config field "jsmcp.normalize_tool_names"',
    ) ?? DEFAULT_JSMCP_CONFIG.normalizeToolNames,
  };
}

function normalizeOptionalBoolean(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
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

async function findConfigPaths(configDirectory) {
  try {
    const entries = await readdir(configDirectory, { withFileTypes: true });
    const entryNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

    return CONFIG_FILE_NAMES.filter((fileName) => entryNames.has(fileName)).map((fileName) => path.join(configDirectory, fileName));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function parseConfig(rawConfig, configPath) {
  const extension = path.extname(configPath).toLowerCase();

  if (extension === ".yaml" || extension === ".yml") {
    return parseYamlConfig(rawConfig, configPath);
  }

  return parseJsonConfig(rawConfig, configPath);
}

function parseJsonConfig(rawConfig, configPath) {
  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`Failed to parse JSON config at ${configPath}: ${getErrorMessage(error)}`);
  }
}

function parseYamlConfig(rawConfig, configPath) {
  try {
    return parseYaml(rawConfig);
  } catch (error) {
    throw new Error(`Failed to parse YAML config at ${configPath}: ${getErrorMessage(error)}`);
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

export function normalizePreset(presetName, serversConfig, presetsConfig, jsmcpConfig = DEFAULT_JSMCP_CONFIG) {
  const presetOverrides = selectPresetOverrides(presetName, presetsConfig);
  const normalizedEntries = new Map();

  validatePresetOverrides(presetOverrides, serversConfig);

  for (const [serverName, rawServerConfig] of Object.entries(serversConfig)) {
    const serverConfig = parseServerConfig(serverName, rawServerConfig, jsmcpConfig);
    const rule = Object.hasOwn(presetOverrides, serverName) ? presetOverrides[serverName] : undefined;
    const toolPolicy = parseToolPolicy(serverName, rule, serverConfig.enabled);

    if (!toolPolicy) {
      continue;
    }

    normalizedEntries.set(serverName, {
      name: serverName,
      toolPolicy,
      serverConfig: rule === undefined ? serverConfig : { ...serverConfig, enabled: true },
    });
  }

  return normalizedEntries;
}

function selectPresetOverrides(presetName, presetsConfig) {
  if (presetsConfig === undefined) {
    if (presetName !== DEFAULT_PRESET) {
      throw new Error(`Preset "${presetName}" was not found. Available presets: ${DEFAULT_PRESET}`);
    }

    return {};
  }

  if (presetName === DEFAULT_PRESET && !Object.hasOwn(presetsConfig, DEFAULT_PRESET)) {
    return {};
  }

  const presetConfig = presetsConfig[presetName];
  if (presetConfig === undefined) {
    const availablePresets = new Set(Object.keys(presetsConfig));
    availablePresets.add(DEFAULT_PRESET);
    throw new Error(
      `Preset "${presetName}" was not found. Available presets: ${[...availablePresets].sort().join(", ") || "none"}`,
    );
  }

  return getPlainObject(presetConfig, `Preset "${presetName}"`);
}

function validatePresetOverrides(presetOverrides, serversConfig) {
  for (const serverName of Object.keys(presetOverrides)) {
    if (!Object.hasOwn(serversConfig, serverName)) {
      throw new Error(`Preset override references unknown server "${serverName}".`);
    }
  }
}

function parseServerConfig(serverName, config, jsmcpConfig = DEFAULT_JSMCP_CONFIG) {
  assertValidServerName(serverName);
  const serverConfig = getPlainObject(config, `Server "${serverName}" config`);
  const serverType = normalizeServerType(serverConfig.type, serverName);
  const toolNameConfig = normalizeToolNameConfig(serverConfig, jsmcpConfig, serverName);

  if (serverType === "local") {
    const command = normalizeCommand(serverConfig.command, serverConfig.args, serverName);

    return {
      type: "local",
      description: typeof serverConfig.description === "string" ? serverConfig.description : undefined,
      command,
      environment: normalizeEnvironmentMap(serverConfig, serverName),
      enabled: serverConfig.enabled !== false,
      timeout: serverConfig.timeout,
      cwd: typeof serverConfig.cwd === "string" ? serverConfig.cwd : undefined,
      ...toolNameConfig,
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
      enabled: serverConfig.enabled !== false,
      timeout: serverConfig.timeout,
      ...toolNameConfig,
      oauth: normalizeOAuthConfig(serverConfig.oauth, serverName),
    };
  }

  throw new Error(
    `Server "${serverName}" must have type "local", "stdio", "remote", "http", or "sse", got ${inspect(serverConfig.type)}.`,
  );
}

function normalizeToolNameConfig(serverConfig, jsmcpConfig, serverName) {
  return {
    ...normalizeStripToolPrefix(serverConfig.strip_tool_prefix, jsmcpConfig, serverName),
    normalizeToolNames:
      normalizeOptionalBoolean(serverConfig.normalize_tool_names, `Server "${serverName}" normalize_tool_names`) ??
      jsmcpConfig.normalizeToolNames,
  };
}

function normalizeStripToolPrefix(value, jsmcpConfig, serverName) {
  if (value === undefined) {
    return {
      stripToolPrefix: undefined,
      inferToolPrefix: jsmcpConfig.autoStripToolPrefixes,
    };
  }

  if (value === true) {
    return {
      stripToolPrefix: undefined,
      inferToolPrefix: true,
    };
  }

  if (value === false) {
    return {
      stripToolPrefix: undefined,
      inferToolPrefix: false,
    };
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Server "${serverName}" strip_tool_prefix must be a non-empty string, true, or false when provided.`);
  }

  return {
    stripToolPrefix: value,
    inferToolPrefix: false,
  };
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

function parseToolPolicy(serverName, rule, enabledByDefault) {
  if (rule === undefined) {
    return enabledByDefault ? { mode: "all" } : null;
  }

  if (rule === false) {
    return null;
  }

  if (rule === true || rule === null) {
    return { mode: "all" };
  }

  if (typeof rule === "string") {
    return {
      mode: "subset",
      selectors: [{ type: "exact", value: rule }],
    };
  }

  if (Array.isArray(rule)) {
    return {
      mode: "subset",
      selectors: rule.map((selector, index) => parseToolSelector(serverName, selector, index)),
    };
  }

  throw new Error(
    `Preset rule for server "${serverName}" must be true, false, a tool name, or an array of tool selectors.`,
  );
}

function parseToolSelector(serverName, selector, index) {
  if (typeof selector === "string") {
    return { type: "exact", value: selector };
  }

  const selectorObject = getPlainObject(selector, `Tool selector ${index} for server "${serverName}"`);

  if (typeof selectorObject.regex === "string") {
    return {
      type: "regex",
      value: selectorObject.regex,
      matcher: createToolRegex(selectorObject.regex, serverName),
    };
  }

  if (typeof selectorObject.glob === "string") {
    return {
      type: "glob",
      value: selectorObject.glob,
      matcher: createToolGlob(selectorObject.glob),
    };
  }

  throw new Error(
    `Tool selector ${index} for server "${serverName}" must be a tool name string or an object with regex or glob.`,
  );
}

function createToolRegex(pattern, serverName) {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid regex preset selector for server "${serverName}": ${getErrorMessage(error)}`);
  }
}

function createToolGlob(pattern) {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
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

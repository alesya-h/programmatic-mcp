import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { cloneJson } from "./utils.js";

export class AuthStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.loaded = false;
    this.data = {
      version: 1,
      servers: {},
    };
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.data = {
          version: 1,
          servers: {},
          ...parsed,
        };
      }
    } catch (error) {
      if (!(error && error.code === "ENOENT")) {
        throw error;
      }
    }

    if (!this.data.servers || typeof this.data.servers !== "object" || Array.isArray(this.data.servers)) {
      this.data.servers = {};
    }

    this.loaded = true;
  }

  async getServerState(serverName) {
    await this.load();
    return cloneJson(this.data.servers[serverName] ?? {});
  }

  async setServerState(serverName, state) {
    await this.load();
    this.data.servers[serverName] = cloneJson(state);
    await this.persist();
  }

  async updateServerState(serverName, updater) {
    await this.load();
    const currentState = cloneJson(this.data.servers[serverName] ?? {});
    const nextState = updater(currentState);
    this.data.servers[serverName] = cloneJson(nextState);
    await this.persist();
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    });
    await this.writeChain;
  }
}

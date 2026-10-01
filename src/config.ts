import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface Config {
  enabled: boolean;
  provider?: string;
  model?: string;
  timeoutMs: number;
  maxTokens: number;
}

export const defaults: Config = {
  enabled: false,
  timeoutMs: 60_000,
  maxTokens: 8192,
};

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配置必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (
      !["enabled", "provider", "model", "timeoutMs", "maxTokens"].includes(key)
    ) {
      throw new Error(`未知配置项：${key}`);
    }
  }
  const config = { ...defaults, ...raw } as Config;
  if (typeof config.enabled !== "boolean")
    throw new Error("enabled 必须是布尔值");
  for (const key of ["provider", "model"] as const) {
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || !config[key]!.trim())
    ) {
      throw new Error(`${key} 必须是非空字符串`);
    }
  }
  if (Boolean(config.provider) !== Boolean(config.model))
    throw new Error("provider 和 model 必须一起配置");
  for (const [key, min, max] of [
    ["timeoutMs", 100, 600_000],
    ["maxTokens", 64, 131_072],
  ] as const) {
    if (
      !Number.isInteger(config[key]) ||
      config[key] < min ||
      config[key] > max
    ) {
      throw new Error(`${key} 必须是 ${min}–${max} 之间的整数`);
    }
  }
  return config;
}

export async function loadConfig(path: string): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...defaults };
    throw error;
  }
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(parseConfig(config), null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

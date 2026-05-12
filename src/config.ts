import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export const CONFIG_DIR = join(process.env.HOME ?? '~', '.zeph');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface ZephConfig {
  apiKey?: string;
  hookId?: string;
  baseUrl?: string;
  deviceId?: string;
}

export const loadConfig = (): ZephConfig => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as ZephConfig;
  } catch {
    return {};
  }
};

export const saveConfig = (config: ZephConfig): void => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
};

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();

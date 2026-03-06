import * as path from "node:path";
import { readdir } from "node:fs/promises";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true
  });

  const testsRoot = path.resolve(__dirname, ".");
  const files = await collectTestFiles(testsRoot);
  files.forEach((file) => mocha.addFile(file));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function collectTestFiles(root: string): Promise<string[]> {
  const collected: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
        collected.push(absolutePath);
      }
    }
  }

  await walk(root);
  return collected;
}

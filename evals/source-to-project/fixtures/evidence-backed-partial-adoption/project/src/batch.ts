import { readFile } from "node:fs/promises";

export async function runBatch(rows: string[], catalogPath: string): Promise<string[]> {
  const output: string[] = [];
  for (const row of rows) {
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, string>;
    output.push(catalog[row] ?? row);
  }
  return output;
}

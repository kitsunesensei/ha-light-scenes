import { readdir, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type ReleaseAsset = {
  path: string;
  name: string;
};

const repoRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(repoRoot, "dist");
const rootAssets = ["modulo-room-lights.yaml"];

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectFiles(entryPath);
      }

      if (entry.isFile()) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat();
}

async function assertFileExists(path: string): Promise<void> {
  const file = await stat(path);

  if (!file.isFile()) {
    throw new Error(`${toPosixPath(relative(repoRoot, path))} is not a file`);
  }
}

export async function releaseAssets(): Promise<ReleaseAsset[]> {
  const [distFiles] = await Promise.all([
    collectFiles(distDir),
    ...rootAssets.map((asset) => assertFileExists(resolve(repoRoot, asset))),
  ]);

  return [...rootAssets.map((asset) => resolve(repoRoot, asset)), ...distFiles]
    .map((path) => toPosixPath(relative(repoRoot, path)))
    .sort((first, second) => first.localeCompare(second))
    .map((path) => ({
      path,
      name: basename(path),
    }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(JSON.stringify(await releaseAssets(), null, 2));
}

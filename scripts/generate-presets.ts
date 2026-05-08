import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import kebabCase from "lodash/kebabCase.js";
import { isMap, isScalar, isSeq, parse, parseDocument } from "yaml";

type Preset = {
  name: string;
  brightness: number;
  lights: number[][];
};

type PresetsFile = {
  presets: Preset[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repoRoot, "modulo-room-lights.yml");
const presetsPath = join(repoRoot, "presets.yml");
const distDir = join(repoRoot, "dist");

function assertPreset(value: unknown, index: number): asserts value is Preset {
  if (!value || typeof value !== "object") {
    throw new Error(`Preset at index ${index} is not an object`);
  }

  const preset = value as Record<string, unknown>;

  if (typeof preset.name !== "string" || preset.name.length === 0) {
    throw new Error(`Preset at index ${index} is missing a valid name`);
  }

  if (typeof preset.brightness !== "number") {
    throw new Error(`Preset "${preset.name}" is missing a numeric brightness`);
  }

  if (
    !Array.isArray(preset.lights) ||
    !preset.lights.every(
      (light) =>
        Array.isArray(light) &&
        light.length === 2 &&
        light.every((channel) => typeof channel === "number"),
    )
  ) {
    throw new Error(`Preset "${preset.name}" is missing valid xy light values`);
  }
}

function parsePresets(source: string): Preset[] {
  const parsed = parse(source) as Partial<PresetsFile>;

  if (!Array.isArray(parsed.presets)) {
    throw new Error("presets.yml must contain a presets array");
  }

  parsed.presets.forEach(assertPreset);

  return parsed.presets;
}

function uniqueFileName(name: string, seen: Map<string, number>): string {
  const slug = kebabCase(name) || "preset";
  const count = seen.get(slug) ?? 0;
  seen.set(slug, count + 1);

  return count === 0 ? `${slug}.yml` : `${slug}-${count + 1}.yml`;
}

function renameKeyDeep(node: unknown, from: string, to: string): void {
  if (isMap(node)) {
    for (const item of node.items) {
      if (isScalar(item.key) && item.key.value === from) {
        item.key.value = to;
      }

      renameKeyDeep(item.value, from, to);
    }

    return;
  }

  if (isSeq(node)) {
    for (const item of node.items) {
      renameKeyDeep(item, from, to);
    }
  }
}

function applyPreset(template: string, preset: Preset): string {
  const document = parseDocument(template);

  if (document.errors.length > 0) {
    throw new Error(
      `Template YAML could not be parsed: ${document.errors
        .map((error) => error.message)
        .join(", ")}`,
    );
  }

  const blueprint = document.get("blueprint", true);
  if (!isMap(blueprint)) {
    throw new Error("Template is missing blueprint");
  }
  blueprint.set("name", preset.name);
  blueprint.delete("description");

  const blueprintInput = blueprint.get("input", true);
  if (!isMap(blueprintInput)) {
    throw new Error("Template is missing blueprint.input");
  }

  const brightnessInput = blueprintInput.get("brightness", true);
  if (!isMap(brightnessInput)) {
    throw new Error("Template is missing blueprint.input.brightness");
  }
  brightnessInput.set("default", preset.brightness);

  for (const item of [...blueprintInput.items]) {
    if (isScalar(item.key) && /^color_\d+$/.test(String(item.key.value))) {
      blueprintInput.delete(item.key.value);
    }
  }

  const variables = document.getIn(["sequence", 0, "variables"], true);
  if (!isMap(variables)) {
    throw new Error("Template is missing sequence[0].variables");
  }

  const colors = document.createNode(preset.lights);
  if (isSeq(colors)) {
    for (const item of colors.items) {
      if (isSeq(item)) {
        item.flow = true;
      }
    }
  }

  variables.delete("color_slots");
  variables.set("colors", colors);
  renameKeyDeep(document.contents, "rgb_color", "xy_color");

  return document.toString({ lineWidth: 0 });
}

async function main(): Promise<void> {
  const [template, presetsSource] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(presetsPath, "utf8"),
  ]);
  const presets = parsePresets(presetsSource);
  const seenFileNames = new Map<string, number>();

  await mkdir(distDir, { recursive: true });

  for (const preset of presets) {
    const fileName = uniqueFileName(preset.name, seenFileNames);
    await writeFile(join(distDir, fileName), applyPreset(template, preset));
  }

  console.log(`Generated ${presets.length} preset files in dist/`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

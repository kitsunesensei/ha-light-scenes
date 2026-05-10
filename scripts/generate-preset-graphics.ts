import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import kebabCase from "lodash/kebabCase.js";
import { parse } from "yaml";

type Preset = {
  name: string;
  brightness: number;
  lights: number[][];
};

type PresetsFile = {
  presets: Preset[];
};

type GeneratedPreset = Preset & {
  assetFileName: string;
  blueprintFileName: string;
  colors: string[];
  theme: Theme;
};

type Theme =
  | "aurora"
  | "city"
  | "cozy"
  | "digital"
  | "flower"
  | "fruit"
  | "holiday"
  | "landscape"
  | "light"
  | "romance"
  | "space"
  | "spooky"
  | "sport"
  | "water";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presetsPath = join(repoRoot, "presets.yaml");
const readmePath = join(repoRoot, "README.md");
const assetsDir = join(repoRoot, "assets", "presets");

const blueprintImportBase =
  "https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https://github.com/kitsunesensei/ha-light-scenes/releases/latest/download";
const blueprintBadge =
  "https://my.home-assistant.io/badges/blueprint_import.svg";

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
    throw new Error("presets.yaml must contain a presets array");
  }

  parsed.presets.forEach(assertPreset);

  return parsed.presets;
}

function uniqueFileName(
  name: string,
  seen: Map<string, number>,
  extension: string,
): string {
  const slug = kebabCase(name) || "preset";
  const count = seen.get(slug) ?? 0;
  seen.set(slug, count + 1);

  return count === 0
    ? `${slug}.${extension}`
    : `${slug}-${count + 1}.${extension}`;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function gammaCorrect(value: number): number {
  const clamped = clamp(value);

  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function channelToHex(value: number): string {
  return Math.round(clamp(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

function xyToHex([x, y]: number[], brightness: number): string {
  const luminance = clamp(brightness / 254, 0.16, 1);
  const safeY = y === 0 ? 0.0001 : y;
  const bigX = (luminance / safeY) * x;
  const bigZ = (luminance / safeY) * (1 - x - y);

  let red = bigX * 3.2406 + luminance * -1.5372 + bigZ * -0.4986;
  let green = bigX * -0.9689 + luminance * 1.8758 + bigZ * 0.0415;
  let blue = bigX * 0.0557 + luminance * -0.204 + bigZ * 1.057;
  const maxChannel = Math.max(red, green, blue, 1);

  red /= maxChannel;
  green /= maxChannel;
  blue /= maxChannel;

  return `#${channelToHex(gammaCorrect(red))}${channelToHex(
    gammaCorrect(green),
  )}${channelToHex(gammaCorrect(blue))}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");

  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round(clamp(channel / 255) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mix(first: string, second: string, amount: number): string {
  const [firstRed, firstGreen, firstBlue] = hexToRgb(first);
  const [secondRed, secondGreen, secondBlue] = hexToRgb(second);
  const ratio = clamp(amount);

  return rgbToHex(
    firstRed + (secondRed - firstRed) * ratio,
    firstGreen + (secondGreen - firstGreen) * ratio,
    firstBlue + (secondBlue - firstBlue) * ratio,
  );
}

function luminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;

    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });

  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function paletteFor(preset: Preset): string[] {
  const colors = preset.lights.map((light) =>
    xyToHex(light, preset.brightness),
  );

  if (colors.length === 1) {
    const [color] = colors;

    return [
      mix(color, "#000000", 0.42),
      color,
      mix(color, "#ffffff", 0.42),
      mix(color, "#ffffff", 0.68),
      mix(color, "#000000", 0.18),
    ];
  }

  return colors;
}

function colorAt(colors: string[], index: number): string {
  return colors[index % colors.length];
}

function chooseTheme(name: string): Theme {
  const normalized = name.toLowerCase();
  const has = (...needles: string[]): boolean =>
    needles.some((needle) => normalized.includes(needle));

  if (
    has(
      "aurora",
      "arctic",
      "frost",
      "snow",
      "winter",
      "midwinter",
      "crystalline",
    )
  ) {
    return "aurora";
  }

  if (has("galaxy", "star", "moon", "nebula", "starlight", "night")) {
    return "space";
  }

  if (
    has(
      "lake",
      "ocean",
      "lagoon",
      "waters",
      "coastal",
      "sailing",
      "adrift",
      "island",
      "shore",
      "cancun",
      "honolulu",
      "ibiza",
      "miami",
      "palm",
      "santorini",
      "tropical",
    )
  ) {
    return "water";
  }

  if (
    has(
      "mountain",
      "ridge",
      "valley",
      "hills",
      "savanna",
      "forest",
      "woodland",
      "fields",
      "meadow",
      "autumn",
      "harvest",
    )
  ) {
    return "landscape";
  }

  if (
    has("blossom", "bloom", "crocus", "lily", "narcissa", "breath", "spring")
  ) {
    return "flower";
  }

  if (
    has(
      "pumpkin",
      "hocus",
      "trick",
      "treat",
      "witch",
      "toil",
      "trouble",
      "spell",
      "phantom",
      "grins",
      "pandemonium",
    )
  ) {
    return "spooky";
  }

  if (has("jolly", "festive", "tree", "nutcracker", "silent", "golden star")) {
    return "holiday";
  }

  if (has("love", "romance", "smitten", "ruby", "rosy", "promise")) {
    return "romance";
  }

  if (has("watermelon", "popsicle", "fruity", "orange", "amber robin")) {
    return "fruit";
  }

  if (
    has("silverstone", "zandvoort", "suzuka", "bahrain", "singapore", "paulo")
  ) {
    return "sport";
  }

  if (
    has(
      "vapor",
      "cga",
      "secam",
      "cycles",
      "valetudo",
      "hal",
      "tyrell",
      "magneto",
      "disturbia",
    )
  ) {
    return "digital";
  }

  if (has("city", "downtown", "soho", "tokyo", "osaka", "rome", "rio")) {
    return "city";
  }

  if (has("relax", "rest", "sleepy", "unwind", "read", "cozy", "dimmed")) {
    return "cozy";
  }

  return "light";
}

function gradientStops(colors: string[]): string {
  const last = colors.length - 1;

  return colors
    .map(
      (color, index) =>
        `<stop offset="${Math.round((index / last) * 100)}%" stop-color="${color}"/>`,
    )
    .join("");
}

function background(colors: string[], id: string): string {
  const base = colorAt(colors, 0);
  const contrast = luminance(base) > 0.5 ? "#10141f" : "#f8fbff";

  return `
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="1" y2="1">
      ${gradientStops(colors)}
    </linearGradient>
    <radialGradient id="glow-${id}" cx="78%" cy="20%" r="70%">
      <stop offset="0%" stop-color="${mix(colorAt(colors, 2), "#ffffff", 0.45)}" stop-opacity=".72"/>
      <stop offset="62%" stop-color="${colorAt(colors, 1)}" stop-opacity=".14"/>
      <stop offset="100%" stop-color="${colorAt(colors, 0)}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft-${id}" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <rect width="320" height="180" rx="22" fill="url(#bg-${id})"/>
  <rect width="320" height="180" rx="22" fill="url(#glow-${id})"/>
  <rect x="10" y="10" width="300" height="160" rx="17" fill="none" stroke="${contrast}" stroke-opacity=".18" stroke-width="2"/>`;
}

function renderAurora(colors: string[]): string {
  return `
  <path d="M0 132 C54 98 88 112 128 82 C170 50 207 68 320 36 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 0),
    "#000000",
    0.22,
  )}" opacity=".58"/>
  <path d="M22 126 C70 42 111 148 159 48 C190 -16 237 85 295 22" fill="none" stroke="${colorAt(
    colors,
    2,
  )}" stroke-width="16" stroke-linecap="round" opacity=".72" filter="url(#soft-main)"/>
  <path d="M16 112 C76 76 113 108 159 64 C211 13 248 67 306 34" fill="none" stroke="${mix(
    colorAt(colors, 3),
    "#ffffff",
    0.32,
  )}" stroke-width="6" stroke-linecap="round" opacity=".82"/>
  <circle cx="48" cy="36" r="2" fill="#fff" opacity=".8"/>
  <circle cx="252" cy="56" r="1.8" fill="#fff" opacity=".68"/>
  <circle cx="226" cy="27" r="1.2" fill="#fff" opacity=".78"/>`;
}

function renderCity(colors: string[]): string {
  const windows = Array.from({ length: 22 }, (_, index) => {
    const x = 30 + index * 12;
    const y = 92 + ((index * 19) % 52);

    return `<rect x="${x}" y="${y}" width="5" height="8" rx="1.5" fill="${colorAt(
      colors,
      index + 2,
    )}" opacity=".74"/>`;
  }).join("");

  return `
  <path d="M0 138 L38 114 L74 130 L108 86 L146 117 L192 70 L238 110 L320 82 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 0),
    "#000000",
    0.38,
  )}" opacity=".62"/>
  <rect x="32" y="76" width="34" height="104" rx="3" fill="${mix(colorAt(colors, 1), "#000000", 0.38)}" opacity=".78"/>
  <rect x="86" y="54" width="44" height="126" rx="3" fill="${mix(colorAt(colors, 2), "#000000", 0.44)}" opacity=".8"/>
  <rect x="152" y="88" width="38" height="92" rx="3" fill="${mix(colorAt(colors, 0), "#000000", 0.3)}" opacity=".82"/>
  <rect x="214" y="60" width="50" height="120" rx="3" fill="${mix(colorAt(colors, 3), "#000000", 0.45)}" opacity=".78"/>
  ${windows}
  <path d="M0 146 C72 130 142 161 218 139 C260 127 292 129 320 137 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 4),
    "#000000",
    0.16,
  )}" opacity=".75"/>`;
}

function renderCozy(colors: string[]): string {
  return `
  <ellipse cx="160" cy="103" rx="76" ry="54" fill="${mix(colorAt(colors, 0), "#000000", 0.22)}" opacity=".42" filter="url(#soft-main)"/>
  <path d="M112 118 C114 82 134 62 160 62 C186 62 206 82 208 118 Z" fill="${mix(
    colorAt(colors, 1),
    "#ffffff",
    0.08,
  )}" opacity=".85"/>
  <path d="M130 118 C132 93 144 79 160 79 C176 79 188 93 190 118 Z" fill="${colorAt(colors, 2)}" opacity=".8"/>
  <rect x="103" y="118" width="114" height="10" rx="5" fill="${mix(colorAt(colors, 3), "#000000", 0.18)}"/>
  <path d="M120 132 C146 147 176 147 202 132" fill="none" stroke="${mix(
    colorAt(colors, 4),
    "#ffffff",
    0.15,
  )}" stroke-width="8" stroke-linecap="round" opacity=".7"/>
  <circle cx="160" cy="93" r="15" fill="${mix(colorAt(colors, 3), "#ffffff", 0.55)}" opacity=".55"/>`;
}

function renderDigital(colors: string[]): string {
  const lines = Array.from({ length: 9 }, (_, index) => {
    const y = 28 + index * 15;

    return `<path d="M${18 + index * 4} ${y} H${302 - index * 3}" stroke="${colorAt(
      colors,
      index,
    )}" stroke-width="${index % 3 === 0 ? 4 : 2}" opacity=".52"/>`;
  }).join("");

  return `
  ${lines}
  <path d="M32 138 H92 L116 111 H164 L188 82 H288" fill="none" stroke="${mix(
    colorAt(colors, 2),
    "#ffffff",
    0.3,
  )}" stroke-width="8" stroke-linejoin="round" stroke-linecap="round" opacity=".82"/>
  <path d="M48 52 H118 L145 77 H204 L236 44 H282" fill="none" stroke="${colorAt(
    colors,
    3,
  )}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity=".78"/>
  <rect x="122" y="88" width="76" height="46" rx="8" fill="${mix(colorAt(colors, 0), "#000000", 0.38)}" opacity=".72"/>
  <rect x="137" y="103" width="46" height="16" rx="3" fill="${mix(colorAt(colors, 4), "#ffffff", 0.28)}" opacity=".82"/>`;
}

function renderFlower(colors: string[]): string {
  const petals = Array.from({ length: 12 }, (_, index) => {
    const rotation = index * 30;

    return `<ellipse cx="160" cy="84" rx="18" ry="48" fill="${colorAt(
      colors,
      index,
    )}" opacity=".62" transform="rotate(${rotation} 160 100)"/>`;
  }).join("");

  return `
  ${petals}
  <circle cx="160" cy="100" r="30" fill="${mix(colorAt(colors, 2), "#ffffff", 0.34)}" opacity=".9"/>
  <path d="M158 126 C150 145 132 154 104 158" fill="none" stroke="${mix(
    colorAt(colors, 3),
    "#000000",
    0.18,
  )}" stroke-width="7" stroke-linecap="round"/>
  <path d="M124 147 C108 128 87 127 66 142 C90 147 105 158 124 147 Z" fill="${colorAt(
    colors,
    1,
  )}" opacity=".65"/>
  <circle cx="160" cy="100" r="10" fill="${mix(colorAt(colors, 4), "#ffffff", 0.58)}"/>`;
}

function renderFruit(colors: string[]): string {
  return `
  <circle cx="161" cy="92" r="66" fill="${mix(colorAt(colors, 0), "#ffffff", 0.08)}" opacity=".78"/>
  <circle cx="161" cy="92" r="47" fill="${colorAt(colors, 2)}" opacity=".74"/>
  <path d="M98 95 A63 63 0 0 0 224 95 L207 132 C180 151 136 151 113 132 Z" fill="${mix(
    colorAt(colors, 3),
    "#ffffff",
    0.2,
  )}" opacity=".84"/>
  <path d="M93 89 A68 68 0 0 1 229 89" fill="none" stroke="${mix(
    colorAt(colors, 4),
    "#000000",
    0.14,
  )}" stroke-width="13" stroke-linecap="round" opacity=".75"/>
  <circle cx="139" cy="108" r="4" fill="${mix(colorAt(colors, 1), "#000000", 0.42)}" opacity=".72"/>
  <circle cx="169" cy="117" r="4" fill="${mix(colorAt(colors, 1), "#000000", 0.42)}" opacity=".72"/>
  <circle cx="191" cy="100" r="4" fill="${mix(colorAt(colors, 1), "#000000", 0.42)}" opacity=".72"/>`;
}

function renderHoliday(colors: string[]): string {
  return `
  <path d="M160 30 L98 132 H222 Z" fill="${mix(colorAt(colors, 1), "#000000", 0.2)}" opacity=".8"/>
  <path d="M160 58 L83 154 H237 Z" fill="${mix(colorAt(colors, 2), "#000000", 0.12)}" opacity=".72"/>
  <rect x="147" y="139" width="26" height="28" rx="4" fill="${mix(colorAt(colors, 0), "#000000", 0.4)}" opacity=".7"/>
  <path d="M160 31 L166 45 L181 45 L169 54 L174 69 L160 60 L146 69 L151 54 L139 45 L154 45 Z" fill="${mix(
    colorAt(colors, 3),
    "#ffffff",
    0.34,
  )}"/>
  <circle cx="137" cy="96" r="5" fill="${colorAt(colors, 4)}"/>
  <circle cx="182" cy="111" r="5" fill="${colorAt(colors, 0)}"/>
  <circle cx="160" cy="128" r="5" fill="${mix(colorAt(colors, 2), "#ffffff", 0.36)}"/>
  <path d="M58 45 H88 M232 52 H264 M48 126 H83 M237 139 H286" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".52"/>`;
}

function renderLandscape(colors: string[]): string {
  return `
  <circle cx="252" cy="54" r="26" fill="${mix(colorAt(colors, 3), "#ffffff", 0.36)}" opacity=".82"/>
  <path d="M0 124 L76 64 L132 126 L184 54 L320 132 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 0),
    "#000000",
    0.18,
  )}" opacity=".75"/>
  <path d="M0 145 C55 119 98 133 142 112 C194 88 233 126 320 93 L320 180 L0 180 Z" fill="${colorAt(
    colors,
    1,
  )}" opacity=".64"/>
  <path d="M0 160 C64 137 110 158 164 136 C216 115 260 141 320 123 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 2),
    "#000000",
    0.12,
  )}" opacity=".72"/>
  <path d="M184 54 L156 98 L206 94 Z" fill="${mix(colorAt(colors, 4), "#ffffff", 0.5)}" opacity=".52"/>`;
}

function renderLight(colors: string[]): string {
  const rays = Array.from({ length: 16 }, (_, index) => {
    const rotation = index * 22.5;

    return `<path d="M160 100 L160 20" stroke="${colorAt(
      colors,
      index,
    )}" stroke-width="8" stroke-linecap="round" opacity=".38" transform="rotate(${rotation} 160 100)"/>`;
  }).join("");

  return `
  ${rays}
  <circle cx="160" cy="100" r="56" fill="${mix(colorAt(colors, 1), "#ffffff", 0.2)}" opacity=".78"/>
  <circle cx="160" cy="100" r="32" fill="${mix(colorAt(colors, 3), "#ffffff", 0.54)}" opacity=".88"/>
  <path d="M114 136 C142 154 180 154 207 136" fill="none" stroke="${mix(
    colorAt(colors, 4),
    "#000000",
    0.18,
  )}" stroke-width="9" stroke-linecap="round" opacity=".62"/>`;
}

function renderRomance(colors: string[]): string {
  return `
  <path d="M161 137 C115 109 84 87 91 58 C96 37 123 35 160 68 C197 35 224 37 229 58 C236 87 207 109 161 137 Z" fill="${mix(
    colorAt(colors, 1),
    "#ffffff",
    0.12,
  )}" opacity=".9"/>
  <path d="M161 124 C127 102 107 84 112 65 C116 52 135 52 160 75 C185 52 204 52 208 65 C213 84 193 102 161 124 Z" fill="${colorAt(
    colors,
    3,
  )}" opacity=".72"/>
  <circle cx="78" cy="52" r="6" fill="${mix(colorAt(colors, 2), "#ffffff", 0.44)}" opacity=".76"/>
  <circle cx="251" cy="116" r="8" fill="${mix(colorAt(colors, 4), "#ffffff", 0.34)}" opacity=".72"/>
  <path d="M68 126 C96 112 115 129 137 112" fill="none" stroke="${mix(
    colorAt(colors, 0),
    "#ffffff",
    0.26,
  )}" stroke-width="5" stroke-linecap="round" opacity=".62"/>`;
}

function renderSpace(colors: string[]): string {
  const stars = Array.from({ length: 30 }, (_, index) => {
    const x = 22 + ((index * 47) % 276);
    const y = 18 + ((index * 31) % 134);
    const radius = 1 + (index % 3) * 0.6;

    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="#fff" opacity="${0.35 + (index % 5) * 0.1}"/>`;
  }).join("");

  return `
  ${stars}
  <circle cx="160" cy="92" r="54" fill="${mix(colorAt(colors, 1), "#000000", 0.26)}" opacity=".82"/>
  <circle cx="181" cy="75" r="48" fill="${mix(colorAt(colors, 0), "#ffffff", 0.1)}" opacity=".44"/>
  <path d="M58 118 C109 88 197 86 263 117" fill="none" stroke="${mix(
    colorAt(colors, 3),
    "#ffffff",
    0.28,
  )}" stroke-width="9" stroke-linecap="round" opacity=".65"/>
  <path d="M69 126 C130 150 199 146 252 121" fill="none" stroke="${colorAt(
    colors,
    2,
  )}" stroke-width="3" stroke-linecap="round" opacity=".72"/>`;
}

function renderSpooky(colors: string[]): string {
  return `
  <circle cx="236" cy="47" r="28" fill="${mix(colorAt(colors, 2), "#ffffff", 0.38)}" opacity=".82"/>
  <path d="M0 140 C60 104 108 128 154 91 C201 54 255 101 320 73 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 0),
    "#000000",
    0.36,
  )}" opacity=".78"/>
  <ellipse cx="145" cy="116" rx="52" ry="39" fill="${mix(colorAt(colors, 1), "#000000", 0.14)}" opacity=".88"/>
  <rect x="137" y="68" width="16" height="28" rx="6" fill="${mix(colorAt(colors, 1), "#000000", 0.12)}" opacity=".88"/>
  <path d="M98 118 C119 93 172 93 192 118" fill="none" stroke="${mix(
    colorAt(colors, 3),
    "#ffffff",
    0.18,
  )}" stroke-width="7" stroke-linecap="round" opacity=".68"/>
  <path d="M122 115 L137 125 L122 132 Z M167 115 L152 125 L167 132 Z" fill="${mix(
    colorAt(colors, 4),
    "#ffffff",
    0.35,
  )}" opacity=".78"/>
  <path d="M125 143 C138 151 155 151 167 143" fill="none" stroke="${mix(
    colorAt(colors, 4),
    "#ffffff",
    0.18,
  )}" stroke-width="4" stroke-linecap="round" opacity=".8"/>`;
}

function renderSport(colors: string[]): string {
  const tiles = Array.from({ length: 18 }, (_, index) => {
    const x = 220 + (index % 6) * 14;
    const y = 34 + Math.floor(index / 6) * 14;
    const fill =
      index % 2 === Math.floor(index / 6) % 2 ? "#ffffff" : "#111827";

    return `<rect x="${x}" y="${y}" width="14" height="14" fill="${fill}" opacity=".72"/>`;
  }).join("");

  return `
  <path d="M38 145 C90 61 178 188 279 52" fill="none" stroke="${mix(
    colorAt(colors, 0),
    "#000000",
    0.24,
  )}" stroke-width="28" stroke-linecap="round" opacity=".62"/>
  <path d="M38 145 C90 61 178 188 279 52" fill="none" stroke="${mix(
    colorAt(colors, 2),
    "#ffffff",
    0.18,
  )}" stroke-width="15" stroke-linecap="round" opacity=".78"/>
  <path d="M38 145 C90 61 178 188 279 52" fill="none" stroke="${colorAt(
    colors,
    4,
  )}" stroke-width="3" stroke-dasharray="18 16" stroke-linecap="round" opacity=".86"/>
  <g transform="rotate(-8 262 56)">${tiles}</g>
  <circle cx="72" cy="132" r="13" fill="${mix(colorAt(colors, 3), "#ffffff", 0.2)}" opacity=".78"/>`;
}

function renderWater(colors: string[]): string {
  return `
  <circle cx="251" cy="48" r="26" fill="${mix(colorAt(colors, 3), "#ffffff", 0.34)}" opacity=".78"/>
  <path d="M0 112 C42 91 72 131 118 109 C169 84 202 119 248 100 C286 84 305 92 320 104 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 0),
    "#000000",
    0.16,
  )}" opacity=".55"/>
  <path d="M0 132 C53 111 83 151 133 130 C178 111 209 139 252 122 C284 109 302 113 320 124 L320 180 L0 180 Z" fill="${colorAt(
    colors,
    1,
  )}" opacity=".64"/>
  <path d="M0 153 C54 131 84 170 134 149 C183 128 211 158 261 139 C288 129 306 132 320 141 L320 180 L0 180 Z" fill="${mix(
    colorAt(colors, 2),
    "#ffffff",
    0.12,
  )}" opacity=".76"/>
  <path d="M46 123 C80 112 96 145 134 130 M174 145 C207 132 230 153 272 139" fill="none" stroke="${mix(
    colorAt(colors, 4),
    "#ffffff",
    0.38,
  )}" stroke-width="5" stroke-linecap="round" opacity=".62"/>`;
}

function renderTheme(theme: Theme, colors: string[]): string {
  switch (theme) {
    case "aurora":
      return renderAurora(colors);
    case "city":
      return renderCity(colors);
    case "cozy":
      return renderCozy(colors);
    case "digital":
      return renderDigital(colors);
    case "flower":
      return renderFlower(colors);
    case "fruit":
      return renderFruit(colors);
    case "holiday":
      return renderHoliday(colors);
    case "landscape":
      return renderLandscape(colors);
    case "romance":
      return renderRomance(colors);
    case "space":
      return renderSpace(colors);
    case "spooky":
      return renderSpooky(colors);
    case "sport":
      return renderSport(colors);
    case "water":
      return renderWater(colors);
    case "light":
      return renderLight(colors);
  }
}

function renderSvg(preset: GeneratedPreset): string {
  const id = "main";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180" role="img" aria-labelledby="title desc">
  <title id="title">${escapeHtml(preset.name)}</title>
  <desc id="desc">Preset artwork using the ${escapeHtml(
    preset.name,
  )} color palette.</desc>
  ${background(preset.colors, id)}
  ${renderTheme(preset.theme, preset.colors)}
</svg>
`;
}

function renderPresetTable(presets: GeneratedPreset[]): string {
  const rows = presets
    .sort((first, second) =>
      first.blueprintFileName.localeCompare(second.blueprintFileName),
    )
    .map((preset) => {
      const importUrl = `${blueprintImportBase}/${preset.blueprintFileName}`;

      return `| <img src="assets/presets/${preset.assetFileName}" alt="${escapeHtml(
        preset.name,
      )}" width="120"> | ${preset.name} | <a href="${importUrl}"><img src="${blueprintBadge}" alt="Open your Home Assistant instance and import this blueprint" width="250"></a> |`;
    })
    .join("\n");

  return `| Grafik | Preset | Import |
| --- | --- | --- |
${rows}`;
}

function replacePresetTable(readme: string, table: string): string {
  const startMarker = "## Presets\n\n";
  const endMarker = "\n\n## License and Third-Party Usage";
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("README.md preset table markers were not found");
  }

  return `${readme.slice(0, start + startMarker.length)}${table}${readme.slice(
    end,
  )}`;
}

async function main(): Promise<void> {
  const [presetsSource, readme] = await Promise.all([
    readFile(presetsPath, "utf8"),
    readFile(readmePath, "utf8"),
  ]);
  const presets = parsePresets(presetsSource);
  const seenBlueprintNames = new Map<string, number>();
  const seenAssetNames = new Map<string, number>();
  const generated = presets.map((preset) => ({
    ...preset,
    assetFileName: uniqueFileName(preset.name, seenAssetNames, "svg"),
    blueprintFileName: uniqueFileName(preset.name, seenBlueprintNames, "yaml"),
    colors: paletteFor(preset),
    theme: chooseTheme(preset.name),
  }));

  await rm(assetsDir, { force: true, recursive: true });
  await mkdir(assetsDir, { recursive: true });

  await Promise.all(
    generated.map((preset) =>
      writeFile(join(assetsDir, preset.assetFileName), renderSvg(preset)),
    ),
  );

  await writeFile(
    readmePath,
    replacePresetTable(readme, renderPresetTable(generated)),
  );

  console.log(
    `Generated ${generated.length} preset graphics in assets/presets/`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

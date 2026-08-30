#!/usr/bin/env node
/**
 * Design-code theme generator for the OpenCode TUI.
 *
 * This script is the executable specification of the design code.  A theme is
 * a single accent ramp, a single secondary ramp, and a shared
 * set of neutrals and semantic ramps — projected onto the fixed role map
 * below.  The role map never changes per theme: the same token is always used
 * for the same job, so the UI stays visually consistent across every theme.
 *
 * Design code rules
 * -----------------
 * 1. Only five colour families may reach the UI chrome:
 *      gray     — neutrals (backgrounds, borders, subdued text)
 *      accent   — THE theme colour (buttons, focus, links, headings,
 *                 list items, unread/running status, diff hunk headers)
 *      blue     — secondary (markdown link labels, enumeration, image
 *                 captions, feedback.info, syntax types)
 *      red      — errors, diff removed
 *      yellow   — warnings, numbers, emphasis
 *      green    — success, strings, diff added
 *    purple and cyan exist only inside `categorical` (spinners/charts) and
 *    never leak into the chrome.
 * 2. `accent` and `interactive` are the same ramp — branding, selection and
 *    action colour must never diverge.  The `orange` slot always carries the
 *    accent ramp and the `blue` slot always carries the secondary ramp, no
 *    matter what the theme is called.
 * 3. Semantic ramps (red/yellow/green) are shared by all themes so that the
 *    meaning of "error", "warning" and "success" never shifts between themes.
 * 4. Syntax and markdown use at most six colours and reuse the same roles:
 *    keyword/function/heading/link/listItem = accent, string/code = green,
 *    number/emphasis = yellow, type/linkText/info = blue, operators and
 *    comments sit on the gray ramp.
 *
 * Adding a theme: append an entry to THEMES below and run
 *   node scripts/generate-themes.mjs
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "config", "themes")

// ---------------------------------------------------------------------------
// Shared ramps (identical in every theme — design code rule 3)
// ---------------------------------------------------------------------------

const GRAY = {
  100: "#ececef", 200: "#d8d8de", 300: "#b3b3bd", 400: "#86868f",
  500: "#5d5d66", 600: "#42424a", 700: "#2e2e34", 800: "#1e1e23",
  900: "#131317",
}

const RED = {
  100: "#f9e2e2", 200: "#f2c4c4", 300: "#e29191", 400: "#d66b6b",
  500: "#bd4b4b", 600: "#a03b3b", 700: "#7f3030", 800: "#5f2424",
  900: "#411a1a",
}

const YELLOW = {
  100: "#f7ecd4", 200: "#eedaa8", 300: "#e2c479", 400: "#d2ad51",
  500: "#b99235", 600: "#977527", 700: "#755a1d", 800: "#544114",
  900: "#3a2d0e",
}

const GREEN = {
  100: "#ddf0e4", 200: "#bfe0cc", 300: "#94c8aa", 400: "#6cab87",
  500: "#4d8e6b", 600: "#3b7356", 700: "#2e5a43", 800: "#224130",
  900: "#172d20",
}

// Categorical-only ramps (spinners, series); never used in chrome.
const PURPLE = {
  100: "#eee4f6", 200: "#ddc9ec", 300: "#c09adc", 400: "#a172c0",
  500: "#85569f", 600: "#6a447e", 700: "#523562", 800: "#3a2647",
  900: "#271a30",
}

const CYAN = {
  100: "#dcefef", 200: "#b9dede", 300: "#8ac5c5", 400: "#5ea7a7",
  500: "#44898a", 600: "#356d6e", 700: "#295454", 800: "#1e3d3d",
  900: "#142a2a",
}

// ---------------------------------------------------------------------------
// Theme catalogue: one accent ramp (the `orange` slot) and one secondary ramp
// (the `blue` slot) per theme.  Everything else is shared.
// ---------------------------------------------------------------------------

const THEMES = {
  "accent-ember": {
    label: "Warm orange accent, denim-blue secondary — closest to the v1 OpenCode look",
    orange: {
      100: "#fdeee2", 200: "#fbd9bc", 300: "#f7b98a", 400: "#f29b5b",
      500: "#eb7c31", 600: "#d25f17", 700: "#a94a10", 800: "#7f360b",
      900: "#582408",
    },
    blue: {
      100: "#deecfa", 200: "#bcd9f4", 300: "#8cb8e9", 400: "#5f95dc",
      500: "#3b74c4", 600: "#2c5ba2", 700: "#224780", 800: "#18335f",
      900: "#112341",
    },
  },
  "accent-ocean": {
    label: "Cool blue accent with a teal secondary",
    orange: {
      100: "#dce9fb", 200: "#bad4f6", 300: "#8ab3ec", 400: "#5d92e1",
      500: "#3a72cd", 600: "#2a58aa", 700: "#214586", 800: "#173262",
      900: "#102343",
    },
    blue: {
      100: "#d9f0ef", 200: "#b4e1df", 300: "#84c9c7", 400: "#57aaa9",
      500: "#3f8c8c", 600: "#317070", 700: "#265857", 800: "#1b4040",
      900: "#122c2c",
    },
  },
  "accent-forest": {
    label: "Moss-green accent, warm gold secondary",
    orange: {
      100: "#e0efe4", 200: "#c0dfc9", 300: "#93c6a3", 400: "#67a87d",
      500: "#4b8a62", 600: "#3b6f4e", 700: "#2e573d", 800: "#213f2c",
      900: "#162b1d",
    },
    blue: {
      100: "#f7ebd2", 200: "#efd7a4", 300: "#e3bd70", 400: "#d2a247",
      500: "#b48530", 600: "#936b26", 700: "#73531e", 800: "#533c16",
      900: "#38280f",
    },
  },
  "accent-graphite": {
    label: "Near-monochrome silver accent — the quiet 'solo' look",
    orange: {
      100: "#ffffff", 200: "#f2f2f5", 300: "#dcdce3", 400: "#bcbcc6",
      500: "#9a9aa6", 600: "#7c7c88", 700: "#5e5e69", 800: "#42424b",
      900: "#2c2c33",
    },
    blue: {
      100: "#e4e9f2", 200: "#c9d2e2", 300: "#a2b1c9", 400: "#7b8daa",
      500: "#5d708e", 600: "#49596f", 700: "#394657", 800: "#29333f",
      900: "#1b222b",
    },
  },
}

// ---------------------------------------------------------------------------
// Fixed role maps.  `$hue.orange.*` = accent, `$hue.blue.*` = secondary.
// These are identical for every theme by design.
// ---------------------------------------------------------------------------

const DARK = {
  text: {
    default: "$hue.neutral.100",
    subdued: "$hue.neutral.400",
    action: {
      primary: { default: "$hue.neutral.100", $disabled: "$hue.neutral.500" },
      secondary: { default: "$text.subdued", $hovered: "$text.default" },
      destructive: { default: "$hue.red.200", $disabled: "$hue.neutral.500" },
    },
    formfield: {
      default: "$hue.neutral.100",
      $focused: "$text.action.primary.default",
      $pressed: "$hue.neutral.200",
      $disabled: "$hue.neutral.500",
      $selected: "$hue.interactive.400",
    },
    status: {
      running: "$hue.interactive.200",
      question: "$text.feedback.info.default",
      permission: "$text.feedback.warning.default",
      unread: "$hue.accent.200",
    },
    feedback: {
      error: { default: "$hue.red.300", subdued: "$hue.red.400" },
      warning: { default: "$hue.yellow.200", subdued: "$hue.yellow.300" },
      success: { default: "$hue.green.300", subdued: "$hue.green.400" },
      info: { default: "$hue.blue.300", subdued: "$hue.blue.400" },
    },
  },
  background: {
    default: "$hue.neutral.900",
    surface: { offset: "$hue.neutral.800", overlay: "$hue.neutral.700" },
    action: {
      primary: {
        default: "$hue.interactive.500",
        $hovered: "$hue.interactive.600",
        $focused: "$hue.interactive.600",
        $pressed: "$hue.interactive.700",
        $selected: "$hue.interactive.600",
        $disabled: "$hue.neutral.800",
      },
      secondary: { default: "transparent" },
      destructive: {
        default: "$hue.red.600",
        $hovered: "$hue.red.700",
        $focused: "$hue.red.700",
        $pressed: "$hue.red.800",
        $selected: "$hue.red.700",
        $disabled: "$hue.neutral.800",
      },
    },
    formfield: {
      default: "$background.default",
      $hovered: "$background.surface.offset",
      $focused: "$background.action.primary.default",
      $pressed: "$hue.interactive.700",
      $disabled: "$background.default",
      $selected: "$background.formfield.default",
    },
    feedback: {
      error: { default: "$background.default" },
      warning: { default: "$background.default" },
      success: { default: "$background.default" },
      info: { default: "$background.default" },
    },
  },
  border: { default: "$hue.neutral.600" },
  scrollbar: { default: "$hue.neutral.500" },
  diff: {
    text: {
      added: "$hue.green.300",
      removed: "$hue.red.300",
      context: "$hue.neutral.100",
      hunkHeader: "$hue.orange.400",
    },
    background: { added: "$hue.green.900", removed: "$hue.red.900", context: "$hue.neutral.900" },
    highlight: { added: "$hue.green.400", removed: "$hue.red.400" },
    lineNumber: {
      text: "$hue.neutral.400",
      background: { added: "$hue.green.800", removed: "$hue.red.800" },
    },
  },
  syntax: {
    comment: "$hue.neutral.400",
    keyword: "$hue.orange.400",
    function: "$hue.orange.400",
    variable: "$hue.neutral.100",
    string: "$hue.green.300",
    number: "$hue.yellow.200",
    type: "$hue.blue.400",
    operator: "$hue.neutral.500",
    punctuation: "$hue.neutral.100",
  },
  markdown: {
    text: "$hue.neutral.100",
    heading: "$hue.orange.400",
    link: "$hue.orange.400",
    linkText: "$hue.blue.300",
    code: "$hue.green.300",
    blockQuote: "$hue.neutral.400",
    emphasis: "$hue.yellow.400",
    strong: "$hue.neutral.100",
    horizontalRule: "$hue.neutral.700",
    listItem: "$hue.orange.400",
    listEnumeration: "$hue.blue.300",
    image: "$hue.orange.400",
    imageText: "$hue.blue.300",
    codeBlock: "$hue.neutral.100",
  },
  "@context:elevated": {
    text: { action: { primary: { default: "$hue.neutral.100" } } },
    background: {
      default: "$hue.neutral.800",
      action: { primary: { default: "$hue.interactive.500", $hovered: "$hue.neutral.700" } },
    },
  },
  "@context:overlay": {
    text: { action: { primary: { default: "$hue.neutral.100" } } },
    background: {
      default: "$hue.neutral.700",
      action: { primary: { default: "$hue.interactive.500" } },
    },
  },
}

const LIGHT = {
  text: {
    default: "$hue.neutral.900",
    subdued: "$hue.neutral.500",
    action: {
      primary: { default: "$hue.neutral.100", $disabled: "$hue.neutral.400" },
      secondary: { default: "$text.subdued", $hovered: "$text.default" },
      destructive: { default: "$hue.red.600", $disabled: "$hue.neutral.500" },
    },
    formfield: {
      default: "$hue.neutral.900",
      $focused: "$text.action.primary.default",
      $pressed: "$hue.neutral.200",
      $disabled: "$hue.neutral.500",
      $selected: "$hue.interactive.700",
    },
    status: {
      running: "$hue.interactive.800",
      question: "$text.feedback.info.default",
      permission: "$text.feedback.warning.default",
      unread: "$hue.accent.800",
    },
    feedback: {
      error: { default: "$hue.red.700", subdued: "$hue.red.600" },
      warning: { default: "$hue.yellow.800", subdued: "$hue.yellow.700" },
      success: { default: "$hue.green.700", subdued: "$hue.green.600" },
      info: { default: "$hue.blue.700", subdued: "$hue.blue.600" },
    },
  },
  background: {
    default: "$hue.neutral.100",
    surface: { offset: "$hue.neutral.200", overlay: "$hue.neutral.300" },
    action: {
      primary: {
        default: "$hue.interactive.600",
        $hovered: "$hue.interactive.700",
        $focused: "$hue.interactive.700",
        $pressed: "$hue.interactive.800",
        $selected: "$hue.interactive.700",
        $disabled: "$hue.neutral.300",
      },
      secondary: { default: "transparent" },
      destructive: {
        default: "$hue.red.600",
        $hovered: "$hue.red.700",
        $focused: "$hue.red.700",
        $pressed: "$hue.red.800",
        $selected: "$hue.red.700",
        $disabled: "$hue.neutral.300",
      },
    },
    formfield: {
      default: "$background.default",
      $hovered: "$background.surface.offset",
      $focused: "$background.action.primary.default",
      $pressed: "$hue.interactive.800",
      $disabled: "$background.default",
      $selected: "$background.formfield.default",
    },
    feedback: {
      error: { default: "$background.default" },
      warning: { default: "$background.default" },
      success: { default: "$background.default" },
      info: { default: "$background.default" },
    },
  },
  border: { default: "$hue.neutral.300" },
  scrollbar: { default: "$hue.neutral.400" },
  diff: {
    text: {
      added: "$hue.green.700",
      removed: "$hue.red.700",
      context: "$hue.neutral.900",
      hunkHeader: "$hue.orange.600",
    },
    background: { added: "$hue.green.100", removed: "$hue.red.100", context: "$hue.neutral.100" },
    highlight: { added: "$hue.green.600", removed: "$hue.red.600" },
    lineNumber: {
      text: "$hue.neutral.600",
      background: { added: "$hue.green.200", removed: "$hue.red.200" },
    },
  },
  syntax: {
    comment: "$hue.neutral.600",
    keyword: "$hue.orange.600",
    function: "$hue.orange.600",
    variable: "$hue.neutral.900",
    string: "$hue.green.700",
    number: "$hue.yellow.800",
    type: "$hue.blue.600",
    operator: "$hue.neutral.600",
    punctuation: "$hue.neutral.900",
  },
  markdown: {
    text: "$hue.neutral.900",
    heading: "$hue.orange.600",
    link: "$hue.orange.600",
    linkText: "$hue.blue.600",
    code: "$hue.green.700",
    blockQuote: "$hue.neutral.600",
    emphasis: "$hue.yellow.500",
    strong: "$hue.neutral.900",
    horizontalRule: "$hue.neutral.300",
    listItem: "$hue.orange.600",
    listEnumeration: "$hue.blue.600",
    image: "$hue.orange.600",
    imageText: "$hue.blue.600",
    codeBlock: "$hue.neutral.900",
  },
  "@context:elevated": {
    text: { action: { primary: { default: "$hue.neutral.100" } } },
    background: {
      default: "$background.surface.offset",
      action: { primary: { default: "$hue.interactive.500", $hovered: "$background.surface.overlay" } },
    },
  },
  "@context:overlay": {
    text: { action: { primary: { default: "$hue.neutral.100" } } },
    background: {
      default: "$background.surface.overlay",
      action: { primary: { default: "$hue.interactive.500" } },
    },
  },
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function variant(roleMap, theme) {
  return {
    hue: {
      gray: GRAY,
      red: RED,
      orange: theme.orange,
      yellow: YELLOW,
      green: GREEN,
      cyan: CYAN,
      blue: theme.blue,
      purple: PURPLE,
      accent: "$hue.orange",
      interactive: "$hue.orange",
      neutral: "$hue.gray",
    },
    categorical: ["blue", "purple", "green", "orange", "red", "cyan"],
    ...roleMap,
  }
}

mkdirSync(OUT, { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) {
  const doc = {
    version: 2,
    dark: variant(DARK, theme),
    light: variant(LIGHT, theme),
  }
  const file = join(OUT, `${name}.json`)
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
  JSON.parse(readFileSync(file, "utf-8")) // fail fast on malformed output
  console.log(`wrote ${file}  (${theme.label})`)
}
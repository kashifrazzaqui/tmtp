import { describe, expect, it } from "vitest";
import { createReaderTheme } from "../../src/ui/theme.js";
import type { ReaderScheme } from "../../src/ui/theme.js";

function luminance(hex: string): number {
  const channels = hex.replace("#", "").match(/.{2}/g)?.map((value) => parseInt(value, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("reader color schemes", () => {
  it.each(["light", "dark", "sepia"] as ReaderScheme[])("should preserve text and state contrast in %s scheme", (scheme) => {
    const theme = createReaderTheme(scheme);
    const { palette } = theme;
    const pairs: Array<[string, string]> = [
      [palette.text.primary, palette.background.default],
      [palette.text.secondary, palette.background.default],
      [palette.primary.main, palette.background.paper],
      [palette.primary.contrastText, palette.primary.main],
      [palette.secondary.main, palette.background.paper],
      [palette.warning.main, palette.background.paper],
      [palette.error.main, palette.background.paper],
    ];
    for (const [foreground, background] of pairs) {
      expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

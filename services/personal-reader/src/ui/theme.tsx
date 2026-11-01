import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CssBaseline, FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import type { PaletteOptions } from "@mui/material/styles";

export type ReaderScheme = "light" | "dark" | "sepia";

const shared = {
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 16,
    h1: { fontSize: "2rem", lineHeight: 1.2, fontWeight: 650, letterSpacing: "-0.025em" },
    h2: { fontSize: "1.55rem", lineHeight: 1.25, fontWeight: 650, letterSpacing: "-0.015em" },
    h3: { fontSize: "1.2rem", lineHeight: 1.35, fontWeight: 650 },
    button: { textTransform: "none" as const, fontWeight: 600 },
  },
  shape: { borderRadius: 8 },
  spacing: 8,
  transitions: {
    duration: { shortest: 80, shorter: 100, short: 140, standard: 160 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: { defaultProps: { variant: "outlined" as const }, styleOverrides: { root: { backgroundImage: "none" } } },
    MuiChip: { defaultProps: { size: "small" as const } },
    MuiDrawer: { styleOverrides: { paper: { maxWidth: "100%" } } },
  },
};

const palettes: Record<ReaderScheme, PaletteOptions> = {
  light: {
    mode: "light",
    primary: { main: "#176b68", light: "#e1efeb", dark: "#0d4b49", contrastText: "#ffffff" },
    secondary: { main: "#715f85", light: "#eee8f2", dark: "#514260", contrastText: "#ffffff" },
    background: { default: "#f4f0e8", paper: "#fcfaf5" },
    text: { primary: "#252a28", secondary: "#5d625e" },
    divider: "#d8d3c8",
    error: { main: "#a43d3d", light: "#f8e8e4", dark: "#782b2b" },
    warning: { main: "#805b12", light: "#f8efd6", dark: "#5e420b" },
    info: { main: "#37647c", light: "#e2edf1", dark: "#294b5e" },
    success: { main: "#376846", light: "#e2eee3", dark: "#274d32" },
  },
  dark: {
    mode: "dark",
    primary: { main: "#82cbc0", light: "#254c48", dark: "#a8ded5", contrastText: "#102b29" },
    secondary: { main: "#c3afd5", light: "#3b3345", dark: "#dbc9e8", contrastText: "#241c2c" },
    background: { default: "#191d1c", paper: "#222725" },
    text: { primary: "#e8e8e1", secondary: "#b6bbb4" },
    divider: "#414943",
    error: { main: "#f0a29b", light: "#4e2d2a", dark: "#ffc2bc" },
    warning: { main: "#e2bf72", light: "#483c23", dark: "#f3d79d" },
    info: { main: "#9dc7dc", light: "#293f4a", dark: "#c1deed" },
    success: { main: "#9bc9a5", light: "#294332", dark: "#c0e1c6" },
  },
  sepia: {
    mode: "light",
    primary: { main: "#276b60", light: "#e5eddb", dark: "#194c45", contrastText: "#ffffff" },
    secondary: { main: "#765b72", light: "#efe3e5", dark: "#594254", contrastText: "#ffffff" },
    background: { default: "#ece0c8", paper: "#f8efdc" },
    text: { primary: "#382f26", secondary: "#6b5d4d" },
    divider: "#cdbb9c",
    error: { main: "#993e35", light: "#f4dfd2", dark: "#702c26" },
    warning: { main: "#795314", light: "#f2e3bf", dark: "#593b0c" },
    info: { main: "#3e6271", light: "#e0e8df", dark: "#2c4954" },
    success: { main: "#45633b", light: "#e3e7cc", dark: "#304829" },
  },
};

interface ReaderSchemeContextValue {
  scheme: ReaderScheme;
  setScheme: (scheme: ReaderScheme) => void;
}

const ReaderSchemeContext = createContext<ReaderSchemeContextValue | undefined>(undefined);

function initialScheme(): ReaderScheme {
  try {
    const saved = sessionStorage.getItem("tmtp.color-scheme.v1");
    if (saved === "light" || saved === "dark" || saved === "sepia") return saved;
  } catch {
    // The default theme applies when storage is unavailable.
  }
  return "light";
}

export function ReaderThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<ReaderScheme>(initialScheme);
  const theme = useMemo(() => createReaderTheme(scheme), [scheme]);

  useEffect(() => {
    document.documentElement.dataset.muiColorScheme = scheme;
    try {
      sessionStorage.setItem("tmtp.color-scheme.v1", scheme);
    } catch {
      // The theme still applies for the live page.
    }
  }, [scheme]);

  const value = useMemo(() => ({ scheme, setScheme }), [scheme]);
  return (
    <ReaderSchemeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ReaderSchemeContext.Provider>
  );
}

export function createReaderTheme(scheme: ReaderScheme) {
  return createTheme({
    ...shared,
    cssVariables: { cssVarPrefix: "reader", nativeColor: true },
    palette: palettes[scheme],
  });
}

export function ColorSchemeSelect() {
  const context = useContext(ReaderSchemeContext);
  if (context === undefined) throw new Error("ColorSchemeSelect must be used inside ReaderThemeProvider.");
  const change = (event: SelectChangeEvent): void => {
    const value = event.target.value;
    if (value === "light" || value === "dark" || value === "sepia") context.setScheme(value);
  };

  return (
    <FormControl size="small" className="scheme-select">
      <InputLabel id="color-scheme-label">Scheme</InputLabel>
      <Select labelId="color-scheme-label" label="Scheme" value={context.scheme} onChange={change}>
        <MenuItem value="light">Warm paper</MenuItem>
        <MenuItem value="dark">Dark</MenuItem>
        <MenuItem value="sepia">Sepia</MenuItem>
      </Select>
    </FormControl>
  );
}

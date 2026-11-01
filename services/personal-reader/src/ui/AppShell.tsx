import { useState } from "react";
import { Alert, AppBar, Box, Chip, Container, Divider, Link, Stack, Toolbar, Typography } from "@mui/material";
import { Link as RouterLink, NavLink, Outlet } from "react-router";
import { useActivity } from "./activity.js";
import { useAuth } from "./auth.js";
import { HealthBanner } from "./HealthBanner.js";
import { useDebugAvailability, useHealth } from "./queries.js";
import { ColorSchemeSelect } from "./theme.js";

function HealthIndicator() {
  const { readiness, capabilities } = useHealth(true);
  const error = readiness.error ?? capabilities.error ?? undefined;
  const ready = readiness.data?.status === "ready" && error === undefined;
  return <Chip size="small" variant="outlined" color={ready ? "success" : "warning"} label={ready ? "Local services ready" : "Health needs attention"} aria-label={ready ? "Service health: ready" : "Service health: attention needed"} />;
}

export function AppShell() {
  const auth = useAuth();
  const activity = useActivity();
  const debug = useDebugAvailability(true);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();

  const logout = async (): Promise<void> => {
    setLogoutPending(true);
    setLogoutError(undefined);
    try {
      await activity.flushAll();
      await auth.logout();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Logout failed.");
    } finally {
      setLogoutPending(false);
    }
  };

  return (
    <Box className="app-shell">
      <Link href="#main-content" className="skip-link">Skip to main content</Link>
      <AppBar position="sticky" color="default" elevation={0} className="app-bar">
        <Toolbar className="app-toolbar">
          <Link component={RouterLink} to="/queue" color="text.primary" underline="none" className="brand" aria-label="Personal Reader queue">
            <span className="brand-mark" aria-hidden="true">PR</span>
            <span>Personal Reader</span>
          </Link>
          <Box component="nav" aria-label="Primary navigation" className="primary-nav">
            <NavLink to="/queue" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>Queue</NavLink>
            <NavLink to="/settings" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>Settings</NavLink>
            {debug.enabled ? <NavLink to="/debug" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>Debug</NavLink> : null}
          </Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }} className="shell-actions">
            <HealthIndicator />
            <ColorSchemeSelect />
            <Link component="button" type="button" underline="always" onClick={() => void logout()} disabled={logoutPending} className="logout-button">
              {logoutPending ? "Logging out…" : "Log out"}
            </Link>
          </Stack>
        </Toolbar>
      </AppBar>
      <Divider />
      {logoutError !== undefined ? <Container maxWidth="lg" sx={{ mt: 2 }}><Alert severity="error">{logoutError} Reading activity may still be queued; try logout again.</Alert></Container> : null}
      <Container maxWidth="lg" sx={{ mt: 2 }}><HealthBanner /></Container>
      <Container component="main" id="main-content" maxWidth="lg" className="main-content" tabIndex={-1}>
        <Outlet />
      </Container>
      <Container component="footer" maxWidth="lg" className="app-footer">
        <Typography variant="body2" color="text.secondary">Private by design · Stored reading stays available when integrations degrade.</Typography>
      </Container>
    </Box>
  );
}

import { useState } from "react";
import { Box, Button } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link as RouterLink, Navigate, Route, Routes, useNavigate } from "react-router";
import { ActivityProvider } from "./activity.js";
import { ApiError } from "./api.js";
import { AuthPanel, AuthProvider, useAuth } from "./auth.js";
import { AppShell } from "./AppShell.js";
import { DebugDrawer } from "./DebugDrawer.js";
import { QueuePage } from "./QueuePage.js";
import { useDebugAvailability } from "./queries.js";
import { SettingsPage } from "./SettingsPage.js";
import { EmptyState, LoadingState } from "./States.js";
import { StoryPage } from "./StoryPage.js";
import { ReaderThemeProvider } from "./theme.js";

function DebugRoute() {
  const navigate = useNavigate();
  const debug = useDebugAvailability(true);
  if (debug.query.isPending) return <LoadingState label="Checking whether diagnostics are enabled…" />;
  if (!debug.enabled) return <Navigate to="/queue" replace />;
  return <DebugDrawer open {...(debug.snapshot === undefined ? {} : { initialSnapshot: debug.snapshot })} onClose={() => navigate("/queue")} />;
}

function NotFound() {
  return <EmptyState title="This page is not in your reading room" action={<Button component={RouterLink} to="/queue" variant="contained">Back to queue</Button>}>The link may be old or the address may be incomplete.</EmptyState>;
}

function AuthenticatedRoutes() {
  const auth = useAuth();
  if (auth.loading) return <Box className="app-loading"><LoadingState label="Checking your session…" /></Box>;
  if (!auth.authenticated || !auth.hasCsrf) return <AuthPanel />;
  return (
    <ActivityProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/queue" replace />} />
          <Route path="/login" element={<Navigate to="/queue" replace />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/stories/:storyId" element={<StoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/debug" element={<DebugRoute />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ActivityProvider>
  );
}

export function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => count < 1 && (error instanceof ApiError ? error.retryable : false),
      },
      mutations: { retry: false },
    },
  }));
  return (
    <QueryClientProvider client={queryClient}>
      <ReaderThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <AuthenticatedRoutes />
          </AuthProvider>
        </BrowserRouter>
      </ReaderThemeProvider>
    </QueryClientProvider>
  );
}

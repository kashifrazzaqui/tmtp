import { createContext, useContext, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Alert, Box, Button, CircularProgress, Container, Link, Paper, Stack, TextField, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, AUTH_REQUIRED_EVENT, getCsrf, setCsrf } from "./api.js";
import { errorMessage } from "./utils.js";

type Session = Awaited<ReturnType<typeof api.session>>;

interface AuthContextValue {
  loading: boolean;
  authenticated: boolean;
  hasCsrf: boolean;
  sessionError?: string;
  expiresAt?: string;
  login: (accessToken: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [hasCsrf, setHasCsrf] = useState(() => getCsrf() !== undefined);
  const session = useQuery<Session>({
    queryKey: ["auth", "session"],
    queryFn: ({ signal }) => api.session(signal),
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    const required = (): void => {
      setCsrf(undefined);
      setHasCsrf(false);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
      queryClient.setQueryData(["auth", "session"], { authenticated: false } satisfies Session);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, required);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, required);
  }, [queryClient]);

  const login = async (accessToken: string): Promise<void> => {
    const result = await api.login(accessToken);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
    setCsrf(result.csrfSecret);
    setHasCsrf(true);
    queryClient.setQueryData(["auth", "session"], {
      authenticated: true,
      expiresAt: result.expiresAt,
      csrfState: "stored",
    } satisfies Session);
  };

  const logout = async (): Promise<void> => {
    await api.logout();
    setCsrf(undefined);
    setHasCsrf(false);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
    queryClient.setQueryData(["auth", "session"], { authenticated: false } satisfies Session);
  };

  const data = session.data;
  return (
    <AuthContext.Provider value={{
      loading: session.isPending,
      authenticated: data?.authenticated === true,
      hasCsrf,
      ...(session.error === null ? {} : { sessionError: errorMessage(session.error) }),
      ...(data?.authenticated === true ? { expiresAt: data.expiresAt } : {}),
      login,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === undefined) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}

export function AuthPanel() {
  const { authenticated, hasCsrf, sessionError, login } = useAuth();
  const [accessToken, setAccessToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (accessToken.length === 0 || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await login(accessToken);
      setAccessToken("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container component="main" maxWidth="sm" className="auth-page">
      <Paper component="section" aria-labelledby="login-heading" className="auth-card" variant="outlined">
        <Stack spacing={3}>
          <Box>
            <Typography component="p" className="eyebrow">YOUR READING ROOM</Typography>
            <Typography component="h1" variant="h1" id="login-heading">Personal Reader</Typography>
            <Typography color="text.secondary" sx={{ mt: 1.5 }}>
              A quiet place for your Hacker News queue, recommendations, and reading history.
            </Typography>
          </Box>
          {authenticated && !hasCsrf ? (
            <Alert severity="info">
              This tab no longer has its security key. Log in again to establish a new session; the old session is not revoked.
            </Alert>
          ) : null}
          {sessionError !== undefined ? <Alert severity="warning">The current session could not be checked: {sessionError}</Alert> : null}
          {error !== undefined ? <Alert severity="error" role="alert">{error}</Alert> : null}
          <Box component="form" onSubmit={(event) => void submit(event)} noValidate>
            <Stack spacing={2}>
              <TextField
                id="access-token"
                label="Access token"
                type="password"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                autoComplete="off"
                autoFocus
                required
                disabled={submitting}
                helperText="Use the access token configured for this service. It is not saved by the browser client."
              />
              <Button type="submit" variant="contained" size="large" disabled={accessToken.length === 0 || submitting}>
                {submitting ? <CircularProgress size={22} color="inherit" aria-label="Logging in" /> : "Log in"}
              </Button>
            </Stack>
          </Box>
          <Typography variant="body2" color="text.secondary">
            The session cookie is HTTP-only. The separate CSRF key stays in this tab’s memory or session storage.
          </Typography>
        </Stack>
      </Paper>
      <Typography component="p" variant="body2" color="text.secondary" align="center" sx={{ mt: 2 }}>
        Return to your <Link href="/queue">reading queue</Link> after logging in.
      </Typography>
    </Container>
  );
}

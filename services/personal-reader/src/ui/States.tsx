import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <Stack className="state-container" sx={{ alignItems: "center" }} spacing={2} role="status">
      <CircularProgress size={30} />
      <Typography color="text.secondary">{label}</Typography>
    </Stack>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Box className="state-container">
      <Stack spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <Typography variant="h2" component="h2">{title}</Typography>
        <Typography color="text.secondary">{children}</Typography>
        {action}
      </Stack>
    </Box>
  );
}

export function ErrorState({ title = "This view could not be loaded", error, retry }: { title?: string; error: unknown; retry?: () => void }) {
  return (
    <Alert
      severity="error"
      className="error-state"
      action={retry === undefined ? undefined : <Button color="inherit" onClick={retry}>Try again</Button>}
    >
      <Typography component="h2" variant="h3">{title}</Typography>
      <Typography variant="body2" sx={{ mt: 0.5 }}>
        {error instanceof Error ? error.message : "The request failed. Try again."}
      </Typography>
    </Alert>
  );
}

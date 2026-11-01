import { Alert, Box, Chip, Collapse, Link, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useHealth } from "./queries.js";
import type { CapabilitiesSnapshot, CapabilityStatus } from "./types.js";
import { sentenceCase } from "./utils.js";

const CAPABILITY_LABELS: Array<[keyof CapabilitiesSnapshot, string]> = [
  ["storedReading", "Stored reading"],
  ["backgroundWork", "Background work"],
  ["llmPersonalization", "Personalization"],
  ["hnPublicCollection", "HN collection"],
  ["hnAccount", "HN account"],
  ["freshArticleContent", "Fresh articles"],
];

function needsAttention(status: CapabilityStatus): boolean {
  return status.state === "degraded" || status.state === "unavailable";
}

export function HealthBanner() {
  const { readiness, capabilities } = useHealth(true);
  const [expanded, setExpanded] = useState(false);
  const snapshot = capabilities.data;
  const notReady = readiness.data?.status === "not-ready";
  const healthError = readiness.error ?? capabilities.error ?? undefined;
  const degraded = snapshot === undefined ? [] : CAPABILITY_LABELS.filter(([key]) => {
    const value = snapshot[key];
    return typeof value === "object" && needsAttention(value as CapabilityStatus);
  });
  if (!notReady && healthError === undefined && degraded.length === 0) return null;

  const storedAvailable = snapshot?.storedReading.state === "available";
  return (
    <Alert
      severity={notReady || !storedAvailable ? "error" : "warning"}
      className="health-banner"
      action={<Link component="button" type="button" color="inherit" underline="always" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>Details</Link>}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {notReady ? "Some local reader services are not ready." : healthError !== undefined ? "Current health could not be checked." : "Some integrations need attention."}
      </Typography>
      {storedAvailable ? <Typography variant="body2">Stored stories and cached articles remain available.</Typography> : null}
      <Collapse in={expanded}>
        <Stack spacing={1.5} sx={{ mt: 1.5 }}>
          {readiness.data?.checks.filter((check) => check.status === "fail").map((check) => (
            <Typography variant="body2" key={check.name}>{sentenceCase(check.name)}: {sentenceCase(check.reason)}</Typography>
          ))}
          {healthError !== undefined ? <Typography variant="body2">{healthError.message}</Typography> : null}
          <Box className="health-list" component="ul" aria-label="Service capabilities">
            {snapshot === undefined ? null : CAPABILITY_LABELS.map(([key, label]) => {
              const status = snapshot[key] as CapabilityStatus;
              return (
                <Box component="li" key={key}>
                  <Chip size="small" variant="outlined" label={`${label}: ${sentenceCase(status.state)}`} />
                  {status.reason !== "ok" ? <Typography component="span" variant="caption" sx={{ ml: 1 }}>{sentenceCase(status.reason)}</Typography> : null}
                </Box>
              );
            })}
          </Box>
        </Stack>
      </Collapse>
    </Alert>
  );
}

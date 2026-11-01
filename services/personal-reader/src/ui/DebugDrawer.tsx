import { useEffect, useState } from "react";
import { Alert, Box, Chip, Divider, Drawer, IconButton, List, ListItem, Stack, Typography } from "@mui/material";
import { streamDebug } from "./api.js";
import type { DebugSnapshot } from "./types.js";
import { formatDate, sentenceCase } from "./utils.js";

type Connection = "connecting" | "live" | "reconnecting";

export function DebugDrawer({ open, onClose, initialSnapshot }: { open: boolean; onClose: () => void; initialSnapshot?: DebugSnapshot }) {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | undefined>(initialSnapshot);
  const [sequence, setSequence] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialSnapshot !== undefined) setSnapshot(initialSnapshot);
  }, [initialSnapshot]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let stopped = false;
    let retryTimer = 0;
    const schedule = (): void => {
      if (stopped) return;
      setConnection("reconnecting");
      retryTimer = window.setTimeout(() => void connect(), 3_000);
    };
    const connect = async (): Promise<void> => {
      if (stopped) return;
      setConnection((current) => current === "live" ? "reconnecting" : "connecting");
      try {
        await streamDebug({
          signal: controller.signal,
          onFrame: (frame) => {
            if (stopped) return;
            setSequence(frame.sequence);
            setSnapshot(frame.snapshot);
            setError(undefined);
            setConnection("live");
          },
        });
        schedule();
      } catch (cause) {
        if (stopped || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "The diagnostics stream disconnected.");
        schedule();
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer !== 0) window.clearTimeout(retryTimer);
    };
  }, [open]);

  return (
    <Drawer anchor="right" open={open} onClose={onClose} aria-labelledby="debug-heading">
      <Box className="debug-drawer">
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <Box>
            <Typography component="p" className="eyebrow">OPT-IN DIAGNOSTICS</Typography>
            <Typography component="h1" variant="h2" id="debug-heading">Live debug window</Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="Close diagnostics" autoFocus>×</IconButton>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Chip size="small" color={connection === "live" ? "success" : "warning"} label={sentenceCase(connection)} />
          {sequence > 0 ? <Typography variant="caption">Frame {sequence}</Typography> : null}
          {snapshot !== undefined ? <Typography variant="caption">{formatDate(snapshot.generatedAt)}</Typography> : null}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Fetch SSE replaces the full snapshot on each frame. There is no replay queue; reconnect begins with a fresh frame.
        </Typography>
        {error !== undefined ? <Alert severity="warning">{error} Retrying without resuming old frames.</Alert> : null}
        {snapshot === undefined ? <Typography role="status">Waiting for the first snapshot…</Typography> : (
          <>
            {snapshot.partial ? <Alert severity="info">Some diagnostic sections are unavailable. Other sections remain readable.</Alert> : null}
            <Box component="section" aria-labelledby="debug-queue-heading">
              <Typography component="h2" variant="h3" id="debug-queue-heading">Queue evaluation</Typography>
              {snapshot.queueCounts.status === "ok" ? (
                <Stack direction="row" spacing={0.75} sx={{ mt: 1 }}>
                  <Chip label={`${snapshot.queueCounts.value.pending} pending`} color="warning" variant="outlined" />
                  <Chip label={`${snapshot.queueCounts.value.scored} scored`} color="success" variant="outlined" />
                  <Chip label={`${snapshot.queueCounts.value.failed} failed`} color="error" variant="outlined" />
                </Stack>
              ) : <Alert severity="warning">Queue counts are unavailable.</Alert>}
              <Typography variant="caption" sx={{ mt: 1, display: "block" }}>LLM payload capture: {snapshot.payloadPolicy.llmPayloads ? "enabled by operator" : "off"}</Typography>
            </Box>
            <Divider />
            <Box component="section" aria-labelledby="debug-profile-heading">
              <Typography component="h2" variant="h3" id="debug-profile-heading">Active profile</Typography>
              {snapshot.activeProfile.status === "ok" && snapshot.activeProfile.value !== undefined ? (
                <Box component="dl" className="detail-list">
                  <dt>ID</dt><dd>{snapshot.activeProfile.value.id}</dd>
                  <dt>Rules</dt><dd>{snapshot.activeProfile.value.rulesVersion}</dd>
                  <dt>Activity</dt><dd>{snapshot.activeProfile.value.activityVersion}</dd>
                  <dt>Policy</dt><dd>{snapshot.activeProfile.value.policyVersion}</dd>
                </Box>
              ) : <Typography color="text.secondary">No active profile is available.</Typography>}
            </Box>
            <Divider />
            <DebugList
              title="Recent sync runs"
              unavailable={snapshot.syncRuns.status !== "ok"}
              items={snapshot.syncRuns.value.items}
              empty="No sync runs in this window."
              render={(run) => `${run.kind} · ${run.status} · ${run.storiesUpserted} stories${run.errorCode === undefined ? "" : ` · ${run.errorCode}`}`}
            />
            <DebugList
              title="Jobs"
              unavailable={snapshot.jobs.status !== "ok"}
              items={snapshot.jobs.value.items}
              empty="No jobs in this window."
              render={(job) => `${job.kind} · ${job.status} · attempt ${job.attempts}/${job.maxAttempts}`}
            />
            <DebugList
              title="Recommendation versions"
              unavailable={snapshot.recommendationVersions.status !== "ok"}
              items={snapshot.recommendationVersions.value.items}
              empty="No recommendation versions in this window."
              render={(version) => `${version.model} · ${version.promptVersion} · ${version.queueEntryCount} entries`}
            />
            <DebugList
              title="LLM usage"
              unavailable={snapshot.llmCalls.status !== "ok"}
              items={snapshot.llmCalls.value.items}
              empty="No LLM calls in this window."
              render={(call) => `${call.purpose} · ${call.status} · ${call.latencyMs} ms · ${(call.inputTokens ?? 0) + (call.outputTokens ?? 0)} tokens${call.errorCode === undefined ? "" : ` · ${call.errorCode}`}`}
            />
            <DebugList
              title="Redacted errors"
              unavailable={snapshot.recentErrors.status !== "ok"}
              items={snapshot.recentErrors.value.items}
              empty="No recent errors in this window."
              render={(item) => `${item.component} · ${item.code} · ${formatDate(item.occurredAt)}`}
            />
          </>
        )}
      </Box>
    </Drawer>
  );
}

function DebugList<T>({ title, items, unavailable, empty, render }: { title: string; items: T[]; unavailable: boolean; empty: string; render: (item: T) => string }) {
  return (
    <Box component="section" aria-label={title}>
      <Typography component="h2" variant="h3">{title}</Typography>
      {unavailable ? <Alert severity="warning">This section is unavailable.</Alert> : items.length === 0 ? <Typography color="text.secondary">{empty}</Typography> : (
        <List dense className="debug-list">
          {items.map((item, index) => <ListItem key={index} disableGutters><Typography variant="body2">{render(item)}</Typography></ListItem>)}
        </List>
      )}
    </Box>
  );
}

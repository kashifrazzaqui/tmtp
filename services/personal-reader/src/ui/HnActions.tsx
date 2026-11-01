import { useRef, useState } from "react";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, List, ListItem, Stack, Typography } from "@mui/material";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";
import type { HnActionKind, HnActionResultDto } from "./types.js";
import { createId, formatDate, sentenceCase } from "./utils.js";

const ACTION_LABELS: Record<HnActionKind, string> = { upvote: "Upvote", flag: "Flag", favorite: "Favorite" };

function Outcome({ result }: { result: HnActionResultDto }) {
  const severity = result.status === "verified" ? "success" : result.status === "indeterminate" ? "warning" : "error";
  return (
    <Alert severity={severity} role="status">
      <strong>{sentenceCase(result.status)}.</strong>{" "}
      {result.status === "verified" ? "Hacker News verified the action." : result.status === "indeterminate" ? "The outcome could not be verified. Do not repeat it blindly; reconcile the account first." : "The action failed. No verified outcome was reported."}
      {result.errorCode === undefined ? "" : ` (${sentenceCase(result.errorCode)})`}
    </Alert>
  );
}

export function HnActions({ storyId }: { storyId: number }) {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<HnActionKind>();
  const [outcome, setOutcome] = useState<HnActionResultDto>();
  const [outcomeKind, setOutcomeKind] = useState<HnActionKind>();
  const idempotencyKey = useRef("");
  const capabilities = useQuery({ queryKey: ["hn", "capabilities"], queryFn: ({ signal }) => api.hnCapabilities(signal), staleTime: 30_000 });
  const history = useInfiniteQuery({
    queryKey: ["hn", "history", storyId],
    queryFn: ({ pageParam, signal }) => api.hnHistory(storyId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.length > 0 ? lastPage[lastPage.length - 1]?.id : undefined,
  });
  const action = useMutation({
    mutationFn: (kind: HnActionKind) => api.performHnAction(storyId, kind, idempotencyKey.current),
    onSuccess: async (result, kind) => {
      setOutcome(result);
      setOutcomeKind(kind);
      setConfirmation(undefined);
      await queryClient.invalidateQueries({ queryKey: ["hn", "history", storyId] });
    },
  });
  const reconcile = useMutation({
    mutationFn: api.reconcileHn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["hn", "history", storyId] });
    },
  });
  const mutations = capabilities.data?.find((capability) => capability.name === "mutations");
  const available = mutations?.state === "available";

  const confirm = (kind: HnActionKind): void => {
    idempotencyKey.current = createId("hn");
    setConfirmation(kind);
  };
  const submit = (): void => {
    if (confirmation !== undefined) action.mutate(confirmation);
  };

  return (
    <Box component="section" aria-labelledby="hn-actions-heading" className="hn-actions">
      <Typography component="h2" variant="h2" id="hn-actions-heading">Hacker News actions</Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5 }}>
        These commands affect your Hacker News account. Nothing is sent until you confirm an action.
      </Typography>
      {capabilities.isError ? <Alert severity="warning" sx={{ mt: 2 }}>Account capabilities could not be loaded. Actions are unavailable.</Alert> : null}
      {capabilities.data !== undefined ? (
        <Stack direction="row" useFlexGap spacing={0.75} sx={{ mt: 1.5, flexWrap: "wrap" }} aria-label="HN account capabilities">
          {capabilities.data.map((capability) => <Chip key={capability.name} size="small" variant="outlined" color={capability.state === "available" ? "success" : "default"} label={`${sentenceCase(capability.name)}: ${sentenceCase(capability.state)}`} />)}
        </Stack>
      ) : null}
      {!available && mutations?.reason !== undefined ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{sentenceCase(mutations.reason)}</Typography> : null}
      <Stack direction="row" useFlexGap spacing={1} sx={{ mt: 2, flexWrap: "wrap" }}>
        {(Object.keys(ACTION_LABELS) as HnActionKind[]).map((kind) => (
          <Button
            key={kind}
            variant="outlined"
            disabled={!available || action.isPending || (outcome?.status === "indeterminate" && outcomeKind === kind)}
            onClick={() => confirm(kind)}
          >
            {ACTION_LABELS[kind]}
          </Button>
        ))}
      </Stack>
      {outcome !== undefined ? <Box sx={{ mt: 2 }}><Outcome result={outcome} /></Box> : null}
      {outcome?.status === "indeterminate" || reconcile.isSuccess ? (
        <Button sx={{ mt: 1 }} variant="text" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
          {reconcile.isPending ? "Scheduling reconciliation…" : "Schedule account reconciliation"}
        </Button>
      ) : null}
      {reconcile.isSuccess ? <Alert severity="info" sx={{ mt: 1 }}>Reconciliation was scheduled. Its stored outcome will appear in action history.</Alert> : null}
      {reconcile.isError ? <Alert severity="error" sx={{ mt: 1 }}>{reconcile.error.message}</Alert> : null}

      <Typography component="h3" variant="h3" sx={{ mt: 3 }}>Action history</Typography>
      {history.isPending ? <Typography color="text.secondary">Loading action history…</Typography> : null}
      {history.isError ? <Alert severity="warning">Action history could not be loaded: {history.error.message}</Alert> : null}
      {history.data !== undefined && history.data.pages.every((page) => page.length === 0) ? <Typography color="text.secondary">No account actions have been recorded for this story.</Typography> : null}
      {history.data !== undefined ? (
        <List className="hn-history-list">
          {history.data.pages.flatMap((page) => page).map((intent) => (
            <ListItem key={intent.id} disableGutters>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{ACTION_LABELS[intent.action]} · {sentenceCase(intent.outcome?.status ?? intent.status)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDate(intent.updatedAt)}
                  {(intent.outcome?.errorCode ?? intent.errorCode) === undefined ? "" : ` · ${sentenceCase(intent.outcome?.errorCode ?? intent.errorCode ?? "unknown-error")}`}
                </Typography>
              </Box>
            </ListItem>
          ))}
        </List>
      ) : null}
      {history.hasNextPage ? <Button onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>Load earlier actions</Button> : null}

      <Dialog open={confirmation !== undefined} onClose={() => { if (!action.isPending) setConfirmation(undefined); }} aria-labelledby="hn-confirm-heading">
        <DialogTitle id="hn-confirm-heading">Confirm {confirmation === undefined ? "HN action" : ACTION_LABELS[confirmation].toLowerCase()}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This sends a real {confirmation === undefined ? "action" : ACTION_LABELS[confirmation].toLowerCase()} to Hacker News for story {storyId}. It is not a local preference or a rehearsal.
          </DialogContentText>
          {action.isError ? <Alert severity="error" sx={{ mt: 2 }}>{action.error.message} The same idempotency key will be used if you retry.</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmation(undefined)} disabled={action.isPending}>Cancel</Button>
          <Button onClick={submit} variant="contained" color={confirmation === "flag" ? "error" : "primary"} disabled={action.isPending} autoFocus>
            {action.isPending ? "Sending…" : action.isError ? "Retry with same key" : `Confirm ${confirmation === undefined ? "action" : ACTION_LABELS[confirmation].toLowerCase()}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

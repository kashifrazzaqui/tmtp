import { Alert, FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import { allowedQueueStates } from "./utils.js";
import { useQueueStateMutation } from "./queries.js";
import type { QueueState } from "./types.js";

const LABELS: Record<QueueState, string> = {
  unread: "Unread",
  reading: "Reading",
  read: "Read",
  dismissed: "Dismissed",
  archived: "Archived",
};

export function QueueStateControl({ storyId, state, labelId }: { storyId: number; state: QueueState; labelId: string }) {
  const mutation = useQueueStateMutation(storyId);
  return (
    <>
      <FormControl size="small" className="queue-state-control">
        <InputLabel id={labelId}>Reading state</InputLabel>
        <Select
          labelId={labelId}
          label="Reading state"
          value={state}
          disabled={mutation.isPending}
          onChange={(event) => {
            const next = event.target.value as QueueState;
            if (next !== state) mutation.mutate(next);
          }}
        >
          {allowedQueueStates(state).map((value) => <MenuItem value={value} key={value}>{LABELS[value]}</MenuItem>)}
        </Select>
      </FormControl>
      {mutation.isError ? <Alert severity="error" sx={{ mt: 1, width: "100%" }}>{mutation.error.message}</Alert> : null}
    </>
  );
}

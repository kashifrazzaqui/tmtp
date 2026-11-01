import { useRef, useState } from "react";
import { Alert, Box, Button, Chip, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from "@mui/material";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api.js";
import { QueueList } from "./QueueList.js";
import { EmptyState, ErrorState, LoadingState } from "./States.js";
import type { EvaluationState, QueueState, VisibilityState } from "./types.js";

interface Filters {
  state: QueueState | "";
  evaluationState: EvaluationState | "";
  visibilityState: VisibilityState;
}

const INITIAL_FILTERS: Filters = { state: "", evaluationState: "", visibilityState: "visible" };

export function QueuePage() {
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryKey: ["queue", filters.state, filters.evaluationState, filters.visibilityState, cursor],
    queryFn: ({ signal }) => api.queue({
      ...(filters.state === "" ? {} : { state: filters.state }),
      evaluationState: filters.evaluationState,
      visibilityState: filters.visibilityState,
      ...(cursor === undefined ? {} : { cursor }),
    }, signal),
    placeholderData: keepPreviousData,
    retry: (count, error) => count < 1 && error instanceof ApiError && error.retryable,
  });

  const updateFilter = <Key extends keyof Filters>(key: Key, value: Filters[Key]): void => {
    setFilters((current) => ({ ...current, [key]: value }));
    setCursor(undefined);
    setPrevious([]);
  };
  const reset = (): void => {
    setFilters(INITIAL_FILTERS);
    setCursor(undefined);
    setPrevious([]);
  };
  const next = (): void => {
    if (query.data?.nextCursor === undefined) return;
    setPrevious((items) => [...items, cursor]);
    setCursor(query.data.nextCursor);
    heading.current?.focus();
  };
  const previousPage = (): void => {
    if (previous.length === 0) return;
    setCursor(previous[previous.length - 1]);
    setPrevious((items) => items.slice(0, -1));
    heading.current?.focus();
  };
  const staleCursor = query.error instanceof ApiError && query.error.code === "stale-queue-cursor";

  return (
    <Stack spacing={3}>
      <Box>
        <Typography component="p" className="eyebrow">READ AT YOUR OWN PACE</Typography>
        <Typography component="h1" variant="h1" ref={heading} tabIndex={-1}>Your queue</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Ranked matches sit beside a little exploration. Reading state is always yours to change.
        </Typography>
      </Box>

      <Box component="section" aria-labelledby="queue-filters-heading" className="queue-filters">
        <Typography component="h2" variant="h3" id="queue-filters-heading" className="sr-only">Filter queue</Typography>
        <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: "wrap" }}>
          <FormControl size="small">
            <InputLabel id="filter-state">Reading state</InputLabel>
            <Select labelId="filter-state" label="Reading state" value={filters.state} onChange={(event) => updateFilter("state", event.target.value as Filters["state"])}>
              <MenuItem value="">All states</MenuItem>
              {["unread", "reading", "read", "dismissed", "archived"].map((state) => <MenuItem key={state} value={state}>{state[0]?.toUpperCase()}{state.slice(1)}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="filter-evaluation">Evaluation</InputLabel>
            <Select labelId="filter-evaluation" label="Evaluation" value={filters.evaluationState} onChange={(event) => updateFilter("evaluationState", event.target.value as Filters["evaluationState"])}>
              <MenuItem value="">All evaluations</MenuItem>
              <MenuItem value="pending">Pending{query.data ? ` (${query.data.evaluationCounts.pending})` : ""}</MenuItem>
              <MenuItem value="scored">Scored{query.data ? ` (${query.data.evaluationCounts.scored})` : ""}</MenuItem>
              <MenuItem value="failed">Failed{query.data ? ` (${query.data.evaluationCounts.failed})` : ""}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="filter-visibility">Visibility</InputLabel>
            <Select labelId="filter-visibility" label="Visibility" value={filters.visibilityState} onChange={(event) => updateFilter("visibilityState", event.target.value as Filters["visibilityState"])}>
              <MenuItem value="visible">Visible</MenuItem>
              <MenuItem value="blacklisted">Blacklisted</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Box>

      {query.isPending ? <LoadingState label="Opening your reading queue…" /> : null}
      {query.isError && !staleCursor ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}
      {staleCursor ? (
        <Alert severity="warning" action={<Button color="inherit" onClick={reset}>Return to first page</Button>}>
          The queue changed while you were paging. Restart from the first page to use a fresh cursor.
        </Alert>
      ) : null}
      {query.data !== undefined && query.data.items.length === 0 ? (
        <EmptyState title="No stories in this view" action={<Button variant="outlined" onClick={reset}>Clear filters</Button>}>
          Try another reading state or evaluation filter. New collection can continue in the background.
        </EmptyState>
      ) : null}
      {query.data !== undefined && query.data.items.length > 0 ? <QueueList items={query.data.items} /> : null}
      {query.isPlaceholderData ? <Typography role="status" color="text.secondary">Loading the next page…</Typography> : null}
      {query.data !== undefined ? (
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }} className="queue-pagination">
          <Button variant="outlined" onClick={previousPage} disabled={previous.length === 0 || query.isFetching}>Previous</Button>
          <Chip variant="outlined" label={`Page ${previous.length + 1}`} aria-label={`Page ${previous.length + 1}`} />
          <Button variant="outlined" onClick={next} disabled={query.data.nextCursor === undefined || query.isFetching}>Next</Button>
        </Stack>
      ) : null}
    </Stack>
  );
}

import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Alert, Box, Button, Chip, Divider, Link, Stack, Typography } from "@mui/material";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "./api.js";
import { useActivity, useReaderActivity } from "./activity.js";
import { useQueueStateMutation } from "./queries.js";
import { HnActions } from "./HnActions.js";
import { QueueStateControl } from "./QueueStateControl.js";
import type { StoryDetailDto } from "./types.js";
import { allowedQueueStates, formatDate, safeHost, sentenceCase } from "./utils.js";

export function ReaderView({ detail, onOpenReason }: { detail: StoryDetailDto; onOpenReason: () => void }) {
  const { story, article, queueEntry } = detail;
  const activity = useActivity();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const articleRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const readingRequested = useRef(new Set<number>());
  const completionRequested = useRef(false);
  const [completionError, setCompletionError] = useState<string>();
  const stateMutation = useQueueStateMutation(story.id);
  const refresh = useMutation({
    mutationFn: () => api.refreshArticle(story.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["story", story.id] });
    },
  });
  useReaderActivity(story.id, articleRef, true);
  const readyHtml = article?.status === "ready" ? article.sanitizedHtml : undefined;

  useEffect(() => {
    if (queueEntry.state !== "unread" || readingRequested.current.has(story.id)) return;
    readingRequested.current.add(story.id);
    stateMutation.mutate("reading");
  }, [queueEntry.state, story.id]); // The mutation object intentionally is not an effect input.

  useEffect(() => {
    const root = contentRef.current;
    if (root === null) return;
    for (const anchor of root.querySelectorAll("a")) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer nofollow";
    }
  }, [readyHtml]);

  const complete = async (): Promise<void> => {
    setCompletionError(undefined);
    try {
      if (completionRequested.current) await activity.flush(story.id);
      else {
        completionRequested.current = true;
        await activity.complete(story.id);
      }
      stateMutation.mutate("read");
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : "Reading activity could not be saved.");
    }
  };

  const skip = async (): Promise<void> => {
    setCompletionError(undefined);
    try {
      await activity.skip(story.id);
      await navigate("/queue");
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : "Reading activity could not be saved.");
    }
  };

  const contentLink = (event: MouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a");
    if (anchor === null) return;
    try {
      const url = new URL(anchor.href);
      if (url.protocol === "http:" || url.protocol === "https:") activity.externalOpen(story.id);
    } catch {
      // Sanitized links remain subject to browser URL handling and CSP.
    }
  };

  return (
    <Stack spacing={3} className="reader-page">
      <Stack direction={{ xs: "column", md: "row" }} sx={{ justifyContent: "space-between", alignItems: { md: "flex-start" } }} spacing={2}>
        <Box>
          <Typography component="p" className="eyebrow">{safeHost(detail.originalUrl)}</Typography>
          <Typography component="h1" variant="h1">{story.title}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {article?.byline ?? story.author ?? "Unknown author"} · {formatDate(story.publishedAt)}
            {story.score === undefined ? "" : ` · ${story.score} points`}
            {story.descendants === undefined ? "" : ` · ${story.descendants} comments`}
          </Typography>
        </Box>
        <QueueStateControl storyId={story.id} state={queueEntry.state} labelId={`reader-state-${story.id}`} />
      </Stack>

      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap", alignItems: "center" }}>
        {detail.recommendation === undefined ? null : <Button variant="outlined" onClick={onOpenReason}>Why this story?</Button>}
        <Button component="a" href={detail.originalUrl} target="_blank" rel="noopener noreferrer nofollow" onClick={() => activity.externalOpen(story.id)} variant="outlined">
          {detail.fallback.kind === "hn-discussion" ? "Open HN discussion" : "Open original page"}
        </Button>
        <Chip label={detail.fallback.observationQuality === "partial" ? "External reading is partially observed" : "Fully observed"} variant="outlined" />
      </Stack>

      {activity.pendingCount > 0 ? <Typography role="status" variant="body2" color="text.secondary">Saving {activity.pendingCount} reading {activity.pendingCount === 1 ? "observation" : "observations"}…</Typography> : null}
      {activity.error !== undefined ? <Alert severity="warning">Reading activity is queued for retry: {activity.error}</Alert> : null}
      {article?.excerpt !== undefined && readyHtml === undefined ? <Typography className="article-excerpt">{article.excerpt}</Typography> : null}

      <Box component="article" ref={articleRef} className="article-shell" aria-label={`Article: ${story.title}`}>
        {readyHtml !== undefined ? (
          <div ref={contentRef} className="article-content" onClick={contentLink} dangerouslySetInnerHTML={{ __html: readyHtml }} />
        ) : (
          <Stack spacing={2} className="article-fallback">
            <Typography component="h2" variant="h2">
              {article?.status === "pending" ? "The article is being prepared" : article?.status === "failed" ? "The article could not be extracted" : "No cached article is available"}
            </Typography>
            {article?.status === "failed" && article.errorCode !== undefined ? <Alert severity="warning">Extraction outcome: {sentenceCase(article.errorCode)}</Alert> : null}
            <Typography>
              You can still read this story through its supplied safe link. Dwell and scroll cannot be measured on the external site, so that observation is marked partial.
            </Typography>
            <Link href={detail.originalUrl} target="_blank" rel="noopener noreferrer nofollow" onClick={() => activity.externalOpen(story.id)} underline="always">
              {detail.fallback.kind === "hn-discussion" ? "Continue to the Hacker News discussion" : "Continue to the original page"}
            </Link>
          </Stack>
        )}
      </Box>

      {article?.status !== "ready" ? (
        <Box>
          <Button variant="outlined" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Scheduling article refresh…" : "Refresh article"}
          </Button>
          {refresh.isSuccess ? <Alert severity="success" sx={{ mt: 1 }}>Article refresh was scheduled. This page checks the cached result while it is pending.</Alert> : null}
          {refresh.isError ? <Alert severity="error" sx={{ mt: 1 }}>{refresh.error.message}</Alert> : null}
        </Box>
      ) : null}

      <Divider />
      <Box className="completion-panel">
        <Typography component="h2" variant="h2">Finished reading?</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>Complete the story or skip it without changing its reading state.</Typography>
        {queueEntry.state === "read" ? <Chip color="success" label="Completed" /> : (
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => void complete()} disabled={!allowedQueueStates(queueEntry.state).includes("read") || stateMutation.isPending}>
              {completionRequested.current ? "Retry saving completion" : "Mark complete"}
            </Button>
            <Button variant="outlined" onClick={() => void skip()} disabled={stateMutation.isPending}>Skip story</Button>
          </Stack>
        )}
        {completionError !== undefined ? <Alert severity="error" sx={{ mt: 1 }}>{completionError} Your completion event remains queued for retry.</Alert> : null}
        {stateMutation.isError ? <Alert severity="error" sx={{ mt: 1 }}>{stateMutation.error.message}</Alert> : null}
      </Box>
      <Divider />
      <HnActions storyId={story.id} />
    </Stack>
  );
}

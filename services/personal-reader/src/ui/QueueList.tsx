import { useEffect } from "react";
import { Box, Card, CardContent, Chip, Link, Stack, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router";
import { useActivity } from "./activity.js";
import type { QueueItemDto } from "./types.js";
import { formatShortDate, safeHost, sentenceCase } from "./utils.js";
import { QueueStateControl } from "./QueueStateControl.js";

export function StoryCard({ item }: { item: QueueItemDto }) {
  const { entry, story } = item;
  const { enqueue } = useActivity();
  const score = entry.rankScore === undefined ? undefined : `${Math.round(entry.rankScore * 100)}% match`;

  useEffect(() => {
    enqueue({ storyId: story.id, kind: "impression", source: "embedded-reader" });
  }, [enqueue, story.id]);

  return (
    <Card component="li" className="story-card" data-story-id={story.id}>
      <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack spacing={1}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-start" } }}>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                {entry.rankPosition !== undefined ? <Typography component="span" className="story-rank" aria-label={`Rank ${entry.rankPosition}`}>{entry.rankPosition}</Typography> : null}
                <Typography component="h2" variant="h3" className="story-title">
                  <Link component={RouterLink} to={`/stories/${story.id}`} underline="hover" color="text.primary">
                    {story.title}
                  </Link>
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary" className="story-byline">
                {safeHost(item.originalUrl)} · {formatShortDate(story.publishedAt)}
                {story.author === undefined ? "" : ` · by ${story.author}`}
                {story.score === undefined ? "" : ` · ${story.score} points`}
                {story.descendants === undefined ? "" : ` · ${story.descendants} comments`}
              </Typography>
            </Box>
            <QueueStateControl storyId={story.id} state={entry.state} labelId={`queue-state-${story.id}`} />
          </Stack>
          <Stack direction="row" useFlexGap spacing={0.75} sx={{ flexWrap: "wrap", alignItems: "center" }}>
            <Chip label={sentenceCase(entry.evaluationState)} color={entry.evaluationState === "scored" ? "success" : entry.evaluationState === "failed" ? "error" : "warning"} variant="outlined" />
            <Chip label={entry.kind === "exploration" ? "Exploration" : "Match"} color={entry.kind === "exploration" ? "secondary" : "primary"} variant="outlined" />
            <Chip label={sentenceCase(entry.state)} />
            {entry.visibilityState === "blacklisted" ? <Chip label="Blacklisted" color="error" /> : null}
            {score === undefined ? null : <Typography variant="caption" color="text.secondary">{score}</Typography>}
            {entry.recommendationId === undefined ? null : (
              <Link component={RouterLink} to={`/stories/${story.id}?reason=1`} underline="always" variant="body2" sx={{ ml: "auto" }}>
                Why this story?
              </Link>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function QueueList({ items }: { items: QueueItemDto[] }) {
  return (
    <Box component="ul" className="queue-list" aria-label="Reading queue">
      {items.map((item) => <StoryCard item={item} key={`${item.entry.rankVersion}-${item.story.id}`} />)}
    </Box>
  );
}

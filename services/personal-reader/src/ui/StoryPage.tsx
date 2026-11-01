import { useEffect, useState } from "react";
import { Button, Link } from "@mui/material";
import { Link as RouterLink, useParams, useSearchParams } from "react-router";
import { useStory } from "./queries.js";
import { ReaderView } from "./ReaderView.js";
import { RecommendationReasonDrawer } from "./RecommendationReasonDrawer.js";
import { EmptyState, ErrorState, LoadingState } from "./States.js";

export function StoryPage() {
  const { storyId: rawId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const valid = rawId !== undefined && /^[1-9]\d*$/.test(rawId) && Number.isSafeInteger(Number(rawId));
  const storyId = valid ? Number(rawId) : 0;
  const story = useStory(storyId, valid);
  const [reasonOpen, setReasonOpen] = useState(searchParams.get("reason") === "1");

  useEffect(() => {
    setReasonOpen(searchParams.get("reason") === "1");
  }, [rawId, searchParams]);

  useEffect(() => {
    if (story.data === undefined) return;
    const previous = document.title;
    document.title = `${story.data.story.title} · Personal Reader`;
    return () => { document.title = previous; };
  }, [story.data]);

  if (!valid) {
    return <EmptyState title="Story not found" action={<Button component={RouterLink} to="/queue" variant="contained">Back to queue</Button>}>The story ID in this link is not valid.</EmptyState>;
  }
  if (story.isPending) return <LoadingState label="Opening the cached story…" />;
  if (story.isError) return <ErrorState title="The story could not be opened" error={story.error} retry={() => void story.refetch()} />;
  if (story.data === undefined) return null;

  const closeReason = (): void => {
    setReasonOpen(false);
    if (searchParams.has("reason")) {
      const next = new URLSearchParams(searchParams);
      next.delete("reason");
      setSearchParams(next, { replace: true });
    }
  };

  return (
    <>
      <Link component={RouterLink} to="/queue" underline="always" className="back-link">← Back to queue</Link>
      <ReaderView key={storyId} detail={story.data} onOpenReason={() => setReasonOpen(true)} />
      <RecommendationReasonDrawer recommendation={story.data.recommendation} open={reasonOpen} onClose={closeReason} />
    </>
  );
}

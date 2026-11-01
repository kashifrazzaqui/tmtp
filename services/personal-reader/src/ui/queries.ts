import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.js";
import { useActivity } from "./activity.js";
import type { QueueDto, QueueState, StoryDetailDto } from "./types.js";

export function useQueueStateMutation(storyId: number) {
  const queryClient = useQueryClient();
  const activity = useActivity();
  return useMutation({
    mutationFn: (state: QueueState) => api.setQueueState(storyId, state),
    onSuccess: (entry, state) => {
      queryClient.setQueriesData<QueueDto>({ queryKey: ["queue"] }, (current) => current === undefined ? current : {
        ...current,
        items: current.items.map((item) => item.story.id === storyId ? { ...item, entry } : item),
      });
      queryClient.setQueryData<StoryDetailDto>(["story", storyId], (current) => current === undefined ? current : { ...current, queueEntry: entry });
      if (state === "dismissed") {
        activity.enqueue({ storyId, kind: "dismiss", source: "app-action" });
        void activity.flush(storyId).catch(() => undefined);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });
}

export function useStory(storyId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["story", storyId],
    queryFn: ({ signal }) => api.story(storyId, signal),
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: (query) => query.state.data?.article?.status === "pending" ? 5_000 : false,
    retry: (count, error) => count < 1 && error instanceof ApiError && error.retryable,
  });
}

export function useHealth(enabled: boolean) {
  const readiness = useQuery({
    queryKey: ["health", "ready"],
    queryFn: ({ signal }) => api.readiness(signal),
    enabled,
    refetchInterval: 30_000,
    retry: 1,
  });
  const capabilities = useQuery({
    queryKey: ["health", "capabilities"],
    queryFn: ({ signal }) => api.capabilities(signal),
    enabled,
    refetchInterval: 30_000,
    retry: 1,
  });
  return { readiness, capabilities };
}

export function useDebugAvailability(enabled: boolean) {
  const query = useQuery({
    queryKey: ["debug", "availability"],
    queryFn: ({ signal }) => api.debugState(signal),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return { enabled: query.isSuccess, snapshot: query.data, query };
}

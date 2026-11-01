import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Divider, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Select, Stack, Switch, TextField, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";
import { newPreferenceRule, normalizePreferenceValue, validatePreferenceRules } from "./preferences.js";
import { ErrorState, LoadingState } from "./States.js";
import type { InterestProfileDto, PreferenceEffect, PreferenceKind, PreferenceRuleDto } from "./types.js";
import { formatDate } from "./utils.js";

function ProfileSummary({ profile }: { profile: InterestProfileDto }) {
  return (
    <Box component="section" aria-labelledby="profile-summary-heading" className="profile-summary">
      <Typography component="h2" variant="h2" id="profile-summary-heading">Current profile</Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5 }}>
        Built {formatDate(profile.createdAt)} · {profile.reason}
      </Typography>
      <Stack direction="row" useFlexGap spacing={0.75} sx={{ mt: 1.5, flexWrap: "wrap" }}>
        {profile.interests.length === 0 ? <Chip variant="outlined" label="No inferred interests yet" /> : profile.interests.slice(0, 12).map((interest) => (
          <Chip key={interest.topic} variant="outlined" label={`${interest.topic} · ${interest.weight.toFixed(2)}`} />
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
        Rules {profile.rulesVersion} · Activity {profile.activityVersion} · Policy {profile.policyVersion} · Builder {profile.builderVersion}
      </Typography>
    </Box>
  );
}

export function PreferenceEditor() {
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: ({ signal }) => api.preferences(signal) });
  const [drafts, setDrafts] = useState<PreferenceRuleDto[]>([]);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<string>();
  const [profile, setProfile] = useState<InterestProfileDto>();
  const [reason, setReason] = useState("Manual rebuild from preference settings");

  useEffect(() => {
    if (preferences.data === undefined) return;
    setDrafts(preferences.data.map((rule) => ({ ...rule })));
    setDirty(false);
  }, [preferences.data]);

  const invalidatePersonalization = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["queue"] }),
      queryClient.invalidateQueries({ queryKey: ["story"] }),
      queryClient.invalidateQueries({ queryKey: ["debug", "availability"] }),
    ]);
  };
  const save = useMutation({
    mutationFn: (rules: PreferenceRuleDto[]) => api.replacePreferences(rules),
    onSuccess: async (result) => {
      setProfile(result);
      setDrafts(result.sourceRules.map((rule) => ({ ...rule })));
      setDirty(false);
      setValidation(undefined);
      queryClient.setQueryData(["preferences"], result.sourceRules);
      await invalidatePersonalization();
    },
  });
  const rebuild = useMutation({
    mutationFn: (value: string) => api.rebuild(value),
    onSuccess: async (result) => {
      setProfile(result);
      await invalidatePersonalization();
    },
  });

  const update = (id: string, patch: Partial<Pick<PreferenceRuleDto, "kind" | "effect" | "value" | "enabled">>): void => {
    setDrafts((rules) => rules.map((rule) => {
      if (rule.id !== id) return rule;
      const next = { ...rule, ...patch, updatedAt: new Date().toISOString() };
      try {
        next.normalizedValue = normalizePreferenceValue(next.kind, next.value);
      } catch {
        next.normalizedValue = "";
      }
      return next;
    }));
    setDirty(true);
    setValidation(undefined);
  };
  const submit = (): void => {
    const issue = validatePreferenceRules(drafts);
    setValidation(issue);
    if (issue === undefined) save.mutate(drafts);
  };

  if (preferences.isPending) return <LoadingState label="Loading your preferences…" />;
  if (preferences.isError) return <ErrorState title="Preferences could not be loaded" error={preferences.error} retry={() => void preferences.refetch()} />;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography component="p" className="eyebrow">EXPLICIT CORRECTIONS</Typography>
        <Typography component="h1" variant="h1">Preferences</Typography>
        <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 760 }}>
          Include topics you want more of and exclude what you want less of. Changes apply to future profiles and recommendations; they do not rewrite your reading history.
        </Typography>
      </Box>

      <Box component="section" aria-labelledby="rules-heading">
        <Stack direction="row" spacing={2} sx={{ mb: 2, justifyContent: "space-between", alignItems: "center" }}>
          <Typography component="h2" variant="h2" id="rules-heading">Interest rules</Typography>
          <Button variant="outlined" onClick={() => { setDrafts((rules) => [...rules, newPreferenceRule()]); setDirty(true); }}>Add rule</Button>
        </Stack>
        {drafts.length === 0 ? <Typography color="text.secondary" sx={{ mb: 2 }}>No explicit rules yet. Add one to correct future recommendations.</Typography> : null}
        <Stack component="ol" className="preference-list" spacing={1.5}>
          {drafts.map((rule, index) => (
            <Card component="li" key={rule.id} variant="outlined">
              <CardContent>
                <Stack direction="row" sx={{ mb: 1.5, justifyContent: "space-between", alignItems: "center" }}>
                  <Typography component="h3" variant="h3">Rule {index + 1}</Typography>
                  <IconButton aria-label={`Delete rule ${index + 1}`} onClick={() => { setDrafts((rules) => rules.filter((candidate) => candidate.id !== rule.id)); setDirty(true); }}>×</IconButton>
                </Stack>
                <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ alignItems: { md: "center" } }}>
                  <FormControl size="small" fullWidth>
                    <InputLabel id={`preference-kind-${rule.id}`}>Kind</InputLabel>
                    <Select labelId={`preference-kind-${rule.id}`} label="Kind" value={rule.kind} onChange={(event) => update(rule.id, { kind: event.target.value as PreferenceKind })}>
                      <MenuItem value="topic">Topic</MenuItem>
                      <MenuItem value="keyword">Keyword</MenuItem>
                      <MenuItem value="author">Author</MenuItem>
                      <MenuItem value="domain">Domain</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" fullWidth>
                    <InputLabel id={`preference-effect-${rule.id}`}>Effect</InputLabel>
                    <Select labelId={`preference-effect-${rule.id}`} label="Effect" value={rule.effect} onChange={(event) => update(rule.id, { effect: event.target.value as PreferenceEffect })}>
                      <MenuItem value="include">Include</MenuItem>
                      <MenuItem value="exclude">Exclude</MenuItem>
                    </Select>
                  </FormControl>
                  <TextField
                    size="small"
                    fullWidth
                    label="Value"
                    value={rule.value}
                    onChange={(event) => update(rule.id, { value: event.target.value })}
                    helperText={rule.normalizedValue === "" ? "Enter a valid value" : `Normalized: ${rule.normalizedValue}`}
                    slotProps={{ htmlInput: { maxLength: 256 } }}
                  />
                  <FormControlLabel control={<Switch checked={rule.enabled} onChange={(event) => update(rule.id, { enabled: event.target.checked })} />} label={rule.enabled ? "Enabled" : "Disabled"} />
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
        {validation !== undefined ? <Alert severity="error" sx={{ mt: 2 }}>{validation}</Alert> : null}
        {save.isError ? <Alert severity="error" sx={{ mt: 2 }}>{save.error.message}</Alert> : null}
        {save.isSuccess ? <Alert severity="success" sx={{ mt: 2 }}>Preferences saved. The returned profile is current and related queue work has been invalidated.</Alert> : null}
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button variant="contained" onClick={submit} disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save preferences"}</Button>
          <Button variant="text" disabled={!dirty || save.isPending} onClick={() => { setDrafts((preferences.data ?? []).map((rule) => ({ ...rule }))); setDirty(false); setValidation(undefined); }}>Discard changes</Button>
        </Stack>
      </Box>

      <Divider />
      <Box component="section" aria-labelledby="rebuild-heading">
        <Typography component="h2" variant="h2" id="rebuild-heading">Rebuild personalization</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>Recompute the profile from stored rules and activity. This does not call an HN mutation.</Typography>
        <TextField fullWidth label="Rebuild reason" value={reason} onChange={(event) => setReason(event.target.value)} slotProps={{ htmlInput: { maxLength: 200 } }} helperText={`${reason.length}/200 characters`} />
        <Button variant="outlined" sx={{ mt: 1.5 }} onClick={() => rebuild.mutate(reason)} disabled={reason.trim() === "" || rebuild.isPending}>{rebuild.isPending ? "Rebuilding…" : "Rebuild now"}</Button>
        {rebuild.isSuccess ? <Alert severity="success" sx={{ mt: 1 }}>Personalization was rebuilt.</Alert> : null}
        {rebuild.isError ? <Alert severity="error" sx={{ mt: 1 }}>{rebuild.error.message}</Alert> : null}
      </Box>
      {profile !== undefined ? <ProfileSummary profile={profile} /> : null}
    </Stack>
  );
}

export const SettingsPage = PreferenceEditor;

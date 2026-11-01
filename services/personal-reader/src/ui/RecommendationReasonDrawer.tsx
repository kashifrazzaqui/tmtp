import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Chip, Divider, Drawer, IconButton, Link, List, ListItem, Stack, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router";
import type { RecommendationDto } from "./types.js";
import { formatDate } from "./utils.js";

export function RecommendationReasonDrawer({ recommendation, open, onClose }: { recommendation: RecommendationDto | undefined; open: boolean; onClose: () => void }) {
  return (
    <Drawer anchor="right" open={open} onClose={onClose} aria-labelledby="recommendation-reason-heading">
      <Box className="reason-drawer">
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "flex-start" }} spacing={2}>
          <Box>
            <Typography component="p" className="eyebrow">RECOMMENDATION</Typography>
            <Typography component="h2" variant="h2" id="recommendation-reason-heading">Why this story?</Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="Close recommendation explanation" autoFocus>×</IconButton>
        </Stack>
        {recommendation === undefined ? (
          <Typography color="text.secondary">This queue entry has no scored recommendation yet. The story can still be read while evaluation is pending or unavailable.</Typography>
        ) : (
          <>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Chip color="primary" label={`${Math.round(recommendation.score * 100)}% match`} />
              <Typography variant="body2" color="text.secondary">{formatDate(recommendation.createdAt)}</Typography>
            </Stack>
            <Box component="section" aria-labelledby="rationale-heading">
              <Typography component="h3" variant="h3" id="rationale-heading" gutterBottom>Rationale</Typography>
              <Typography className="recommendation-rationale">{recommendation.rationale}</Typography>
            </Box>
            <Box component="section" aria-labelledby="evidence-heading">
              <Typography component="h3" variant="h3" id="evidence-heading" gutterBottom>Evidence</Typography>
              {recommendation.evidence.length === 0 ? <Typography color="text.secondary">No supporting evidence was returned.</Typography> : (
                <List className="evidence-list">
                  {recommendation.evidence.map((evidence, index) => (
                    <ListItem key={`${evidence.kind}-${evidence.label}-${index}`} disableGutters>
                      <Box>
                        <Chip size="small" variant="outlined" label={evidence.kind.replaceAll("-", " ")} sx={{ mb: 0.75 }} />
                        <Typography>{evidence.label}{evidence.value === undefined ? "" : `: ${evidence.value}`}</Typography>
                        {evidence.sourceId === undefined ? null : <Typography variant="caption" color="text.secondary">Source: {evidence.sourceId}</Typography>}
                      </Box>
                    </ListItem>
                  ))}
                </List>
              )}
            </Box>
            <Typography variant="body2" color="text.secondary">Selected model: {recommendation.model}</Typography>
            <Link component={RouterLink} to="/settings" underline="always">Adjust preferences to correct future recommendations</Link>
            <Divider />
            <Accordion disableGutters elevation={0}>
              <AccordionSummary expandIcon={<span aria-hidden="true">+</span>} aria-controls="recommendation-versions" id="recommendation-versions-heading">
                <Typography variant="body2">Model and version details</Typography>
              </AccordionSummary>
              <AccordionDetails id="recommendation-versions" aria-labelledby="recommendation-versions-heading">
                <Box component="dl" className="detail-list">
                  <dt>Profile</dt><dd>{recommendation.profileId}</dd>
                  <dt>Story version</dt><dd>{recommendation.storyContentVersion}</dd>
                  <dt>Article version</dt><dd>{recommendation.articleContentVersion}</dd>
                  <dt>Prompt version</dt><dd>{recommendation.promptVersion}</dd>
                  <dt>Evidence schema</dt><dd>{recommendation.evidenceSchemaVersion}</dd>
                </Box>
              </AccordionDetails>
            </Accordion>
          </>
        )}
        <Button variant="outlined" onClick={onClose}>Back to story</Button>
      </Box>
    </Drawer>
  );
}

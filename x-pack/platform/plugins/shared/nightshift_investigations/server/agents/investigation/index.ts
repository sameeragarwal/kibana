/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { AgentTypeDefinition } from '@kbn/agent-builder-server/agents';
import { platformSignificantEventsTools } from '@kbn/agent-builder-common/tools';
import {
  NIGHTSHIFT_CORTEX_HYDRATE_WORKFLOW_ID,
  NIGHTSHIFT_CORTEX_OPTIMIZE_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_SANDBOX_SEED_WORKFLOW_ID,
} from '@kbn/workflows/managed';
import instructions from './instructions/investigator.md.text';
import { SANDBOX_BASH_TOOL_ID } from '../../tools/sandbox_bash/tool';
import { SANDBOX_VIEW_FILE_TOOL_ID } from '../../tools/sandbox_bash/view_file_tool';
import { SANDBOX_STR_REPLACE_TOOL_ID } from '../../tools/sandbox_bash/str_replace_tool';
import { SANDBOX_WRITE_FILE_TOOL_ID } from '../../tools/sandbox_bash/write_file_tool';

export const SIGNIFICANT_EVENTS_INVESTIGATION_AGENT_ID = 'significant-events.investigation';
export const SIGNIFICANT_EVENTS_INVESTIGATION_AGENT_TYPE_ID =
  'platform.sig_events.investigation-type';

/** Builds the investigation agent type definition. When the sandbox is enabled,
 * the sandbox-seed pre-execution workflow is wired to the agent via `workflow_ids`
 * on the base configuration so it runs before every agent turn without requiring
 * an admin to configure it on the persisted agent document. */
export const getInvestigationAgentType = ({
  sandboxEnabled,
}: {
  sandboxEnabled: boolean;
}): AgentTypeDefinition => ({
  id: SIGNIFICANT_EVENTS_INVESTIGATION_AGENT_TYPE_ID,
  name: 'Nightshift Investigator',
  description:
    'Investigates an observability issue by querying available signals (logs, traces, metrics), ' +
    'reasoning about causality direction, and producing a contributing-factors conclusion with supporting evidence.',
  avatar_icon: 'logoElastic',
  baseConfiguration: {
    instructions,
    skill_ids: [],
    tools: [
      {
        tool_ids: [
          platformSignificantEventsTools.reportInvestigationProgress,
          ...(sandboxEnabled
            ? [
                SANDBOX_BASH_TOOL_ID,
                SANDBOX_VIEW_FILE_TOOL_ID,
                SANDBOX_STR_REPLACE_TOOL_ID,
                SANDBOX_WRITE_FILE_TOOL_ID,
              ]
            : []),
        ],
      },
    ],
    // Do not inject default ES|QL / index / workflow tools. Telemetry queries run
    // in the sandbox via `/workspace/elastic.md` (curl / python against ES).
    enable_elastic_capabilities: false,
    connector_ids: [],
    // Pre-execution workflows run as the beforeAgent hook. Sandbox seed + Cortex
    // hydrate both write into /workspace; without sandbox config those steps throw
    // and would abort every investigation round.
    ...(sandboxEnabled
      ? {
          workflow_ids: [
            SIGNIFICANT_EVENTS_SANDBOX_SEED_WORKFLOW_ID,
            NIGHTSHIFT_CORTEX_HYDRATE_WORKFLOW_ID,
          ],
        }
      : {}),
    // Post-round workflow is fire-and-forget (afterRound, waitForCompletion: false)
    // so the investigation can finish while Cortex Optimize is still writing.
    post_round_workflow_ids: [NIGHTSHIFT_CORTEX_OPTIMIZE_WORKFLOW_ID],
  },
});

/** @deprecated Use `getInvestigationAgentType` instead. Kept for backwards-compatible access
 * to the type definition in tests and code that doesn't need the sandbox flag. */
export const investigationAgentType = getInvestigationAgentType({ sandboxEnabled: false });

export const registerInvestigationAgentType = (
  agentBuilder: AgentBuilderPluginSetup,
  { sandboxEnabled }: { sandboxEnabled: boolean } = { sandboxEnabled: false }
): void => {
  agentBuilder.agents.registerType(getInvestigationAgentType({ sandboxEnabled }));
};

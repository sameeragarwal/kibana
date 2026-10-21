/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { AgentTypeDefinition } from '@kbn/agent-builder-server/agents';
import { SANDBOX_BASH_TOOL_ID } from '../../tools/sandbox_bash/tool';
import { SANDBOX_VIEW_FILE_TOOL_ID } from '../../tools/sandbox_bash/view_file_tool';
import { NIGHTSHIFT_ASSISTANT_AGENT_ID } from '../../../common';
import type { NightshiftAgentTypeOptions } from '../investigation';
import { buildNightshiftAgentConfiguration } from '../investigation';

export { NIGHTSHIFT_ASSISTANT_AGENT_ID };
export const NIGHTSHIFT_ASSISTANT_AGENT_TYPE_ID = 'platform.nightshift.assistant-type';

export const ASSISTANT_AGENT_NAME = 'Nightshift Assistant';
export const ASSISTANT_AGENT_DESCRIPTION =
  'Answers a single question directly with the Nightshift investigator’s tools and connectors, ' +
  'without running an investigation.';

export const ASSISTANT_INSTRUCTIONS = `You are the Nightshift Assistant. Answer the user's question directly and quickly. This is not
an investigation: do only what the question asks.

Your sandbox workspace documents everything you can use. Read a file with
\`${SANDBOX_VIEW_FILE_TOOL_ID}\` only when the question needs it, and read every file you need in
the same turn:
- \`/workspace/elastic.md\`: everything needed to query Elasticsearch, including the connector,
  indices and remote clusters. For Elasticsearch questions it is the only file you need.
- \`/workspace/connectors.md\`: the other connectors and secrets you may call, and how their
  credentials reach a \`${SANDBOX_BASH_TOOL_ID}\` command. Never guess credentials or endpoints.
- \`/workspace/cortex/README.md\` and \`/workspace/cortex/INDEX.md\`: the team's knowledge wiki.
  Read-only; it is updated after your reply.
- The Semantic Memory paths in <system_update>, or \`/workspace/memories/.index.json\`: past
  observations. Verify them before relying on them.

Run the fewest commands that answer the question and respect any budget the user gives. An error
is an answer: quote it verbatim and never report "no data" unless a request succeeded empty. Never
print, log or write credential values. Use the recording and proposal tools only when asked.

Reply briefly with the answer, the connector and exact request(s) you used, the relevant response
or error, and any limitation.
`;

/**
 * Builds the Nightshift assistant agent type: the investigator's tools, connectors, Cortex and
 * Memory hooks and custom context, behind a short direct-answer prompt. Decision trees are
 * skipped for it by the agent policy.
 */
export const getAssistantAgentType = (
  options: NightshiftAgentTypeOptions
): AgentTypeDefinition => ({
  id: NIGHTSHIFT_ASSISTANT_AGENT_TYPE_ID,
  name: ASSISTANT_AGENT_NAME,
  description: ASSISTANT_AGENT_DESCRIPTION,
  avatar_icon: 'logoElastic',
  baseConfiguration: buildNightshiftAgentConfiguration({
    ...options,
    instructions: ASSISTANT_INSTRUCTIONS,
  }),
});

export const registerAssistantAgentType = (
  agentBuilder: AgentBuilderPluginSetup,
  options: NightshiftAgentTypeOptions
): void => {
  agentBuilder.agents.registerType(getAssistantAgentType(options));
};

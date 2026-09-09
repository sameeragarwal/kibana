/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { platformCoreTools } from '@kbn/agent-builder-common/tools';
import {
  NIGHTSHIFT_CORTEX_HYDRATE_WORKFLOW_ID,
  NIGHTSHIFT_CORTEX_OPTIMIZE_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_SANDBOX_SEED_WORKFLOW_ID,
} from '@kbn/workflows/managed';
import {
  investigationAgentType,
  registerInvestigationAgentType,
  SIGNIFICANT_EVENTS_INVESTIGATION_AGENT_TYPE_ID,
} from '.';
import { SANDBOX_BASH_TOOL_ID } from '../../tools/sandbox_bash/tool';
import { SANDBOX_VIEW_FILE_TOOL_ID } from '../../tools/sandbox_bash/view_file_tool';
import { SANDBOX_STR_REPLACE_TOOL_ID } from '../../tools/sandbox_bash/str_replace_tool';
import { SANDBOX_WRITE_FILE_TOOL_ID } from '../../tools/sandbox_bash/write_file_tool';

const DIRECT_ES_QUERY_TOOL_IDS = [
  platformCoreTools.executeEsql,
  platformCoreTools.generateEsql,
  platformCoreTools.search,
  platformCoreTools.listIndices,
  'observability.get_logs',
  'observability.get_traces',
  'observability.get_services',
  'platform.core.inspect_streams',
  'platform.sig_events.ki_search',
];

describe('investigation agent type', () => {
  it('registers the managed investigation base configuration', () => {
    const agentBuilder = agentBuilderMocks.createSetup();

    registerInvestigationAgentType(agentBuilder);

    expect(agentBuilder.agents.registerType).toHaveBeenCalledWith(investigationAgentType);
    expect(investigationAgentType).toMatchObject({
      id: SIGNIFICANT_EVENTS_INVESTIGATION_AGENT_TYPE_ID,
      baseConfiguration: {
        enable_elastic_capabilities: false,
        connector_ids: [],
        skill_ids: [],
        post_round_workflow_ids: [NIGHTSHIFT_CORTEX_OPTIMIZE_WORKFLOW_ID],
      },
    });
  });

  it('adds sandbox tools and the seed and Cortex hydrate workflows when sandbox is enabled', () => {
    const agentBuilder = agentBuilderMocks.createSetup();

    registerInvestigationAgentType(agentBuilder, { sandboxEnabled: true });

    const registered = agentBuilder.agents.registerType.mock.calls[0][0];
    const configuration =
      typeof registered.baseConfiguration === 'function'
        ? undefined
        : registered.baseConfiguration;
    expect(configuration?.workflow_ids).toEqual([
      SIGNIFICANT_EVENTS_SANDBOX_SEED_WORKFLOW_ID,
      NIGHTSHIFT_CORTEX_HYDRATE_WORKFLOW_ID,
    ]);
    expect(configuration?.post_round_workflow_ids).toEqual([
      NIGHTSHIFT_CORTEX_OPTIMIZE_WORKFLOW_ID,
    ]);
    expect(configuration?.enable_elastic_capabilities).toBe(false);
    expect(configuration?.skill_ids).toEqual([]);
    expect(configuration?.tools[0].tool_ids).toEqual(
      expect.arrayContaining([
        SANDBOX_BASH_TOOL_ID,
        SANDBOX_VIEW_FILE_TOOL_ID,
        SANDBOX_STR_REPLACE_TOOL_ID,
        SANDBOX_WRITE_FILE_TOOL_ID,
      ])
    );
    expect(configuration?.tools[0].tool_ids).toEqual(
      expect.not.arrayContaining(DIRECT_ES_QUERY_TOOL_IDS)
    );
  });
});

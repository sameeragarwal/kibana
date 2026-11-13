/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentDefinition } from '@kbn/agent-builder-common';

export type AgentWithPermissions = AgentDefinition & {
  permissions?: { update_agent: boolean };
};

/**
 * Browser-side UI options for an agent, registered by the plugin that owns it.
 */
export interface AgentUIDefinition {
  /**
   * Show a microphone button in the agent's chat input that dictates speech into the message
   * with the browser's speech recognition. Some browsers (e.g. Chrome) send the audio to a cloud
   * speech service. The button stays hidden when the browser has no speech recognition or the
   * page's Permissions-Policy blocks the microphone, which Kibana does by default; operators
   * allow it with `server.securityResponseHeaders.permissionsPolicy`.
   */
  voiceInput?: boolean;
}

/**
 * Public-faving contract for AgentBuilder's agents service.
 */
export interface AgentsServiceStartContract {
  /**
   * List all agents available.
   */
  list(): Promise<AgentDefinition[]>;

  /**
   * Get an agent by id.
   */
  get(agentId: string): Promise<AgentWithPermissions>;

  /**
   * Add a skill to an agent's configuration, returning the updated agent.
   * Idempotent: a skill already present on the agent leaves it unchanged.
   */
  addSkillToAgent(params: { agentId: string; skillId: string }): Promise<AgentDefinition>;

  /**
   * Add a connector to an agent's `connector_ids`, returning the updated agent.
   * Idempotent: a connector already assigned leaves the agent unchanged.
   */
  addConnectorToAgent(params: { agentId: string; connectorId: string }): Promise<AgentDefinition>;

  /**
   * Remove a connector from an agent's `connector_ids`, returning the updated agent.
   * Idempotent: a connector not assigned leaves the agent unchanged.
   */
  removeConnectorFromAgent(params: {
    agentId: string;
    connectorId: string;
  }): Promise<AgentDefinition>;

  /**
   * Register UI options for an agent. Throws if the agent already has UI options.
   */
  registerUIDefinition(agentId: string, definition: AgentUIDefinition): void;

  /**
   * Resolve the UI options registered for an agent, if any.
   */
  getUIDefinition(agentId: string): AgentUIDefinition | undefined;
}

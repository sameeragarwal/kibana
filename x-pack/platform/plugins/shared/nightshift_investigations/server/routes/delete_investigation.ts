/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { MAX_KEYWORD_LENGTH } from '../../common';
import { createNightshiftInvestigationsServerRoute } from './create_server_route';
import { rethrowInvestigationClientError } from './rethrow_investigation_client_error';

export const deleteInvestigationRoute = createNightshiftInvestigationsServerRoute({
  endpoint: 'DELETE /internal/nightshift/investigations/{id}',
  options: {
    access: 'internal',
    summary: 'Delete an investigation',
    description: 'Removes an investigation record from the current space.',
  },
  security: {
    authz: {
      requiredPrivileges: ['agentBuilder:write'],
    },
  },
  params: z.object({
    path: z.object({
      id: z.string().min(1).max(MAX_KEYWORD_LENGTH),
    }),
  }),
  handler: async ({ request, params, getInvestigationsClient }) => {
    try {
      await getInvestigationsClient(request).delete(params.path.id);
      return { deleted: true as const };
    } catch (err) {
      rethrowInvestigationClientError(err);
    }
  },
});

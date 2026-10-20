/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import type { EvaluationDataset } from '@kbn/evals';
import { DatasetTags } from '@kbn/evals-common';
import { readInvestigationFile } from '../investigation/datasets';
import type { ConnectorProbeExample } from './types';

/** Loads the probe questions from `NIGHTSHIFT_PROBE_EXAMPLES_FILE`, or the bundled ES connector set. */
export const readConnectorProbeDataset = (
  path = process.env.NIGHTSHIFT_PROBE_EXAMPLES_FILE ?? join(__dirname, 'es_connector_quick.json')
): EvaluationDataset<ConnectorProbeExample> => {
  const file = readInvestigationFile(path);
  return {
    name: file.dataset,
    description: file.description ?? 'Direct telemetry questions for the Nightshift assistant.',
    tags: DatasetTags.parse([...new Set(['nightshift', 'connector-probe', ...file.tags])]),
    examples: file.examples,
  };
};

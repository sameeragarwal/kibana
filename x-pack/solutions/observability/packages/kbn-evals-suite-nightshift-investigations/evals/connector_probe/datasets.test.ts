/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { extractReferenceAnswer } from '../investigation/judges/scoring';
import { readConnectorProbeDataset } from './datasets';

describe('readConnectorProbeDataset', () => {
  it('loads the bundled Elasticsearch connector probes, each with a reference answer', () => {
    const dataset = readConnectorProbeDataset();

    expect(dataset.name).toBe('nightshift/es-connector-quick');
    expect(dataset.tags).toEqual(expect.arrayContaining(['nightshift', 'connector-probe']));
    expect(dataset.examples).toHaveLength(25);
    for (const { output } of dataset.examples) {
      expect(extractReferenceAnswer(output)).toEqual(expect.any(String));
    }
  });
});

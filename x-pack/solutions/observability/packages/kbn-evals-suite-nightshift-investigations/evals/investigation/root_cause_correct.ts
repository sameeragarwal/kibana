/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DefaultEvaluators, Evaluator } from '@kbn/evals';
import type { InvestigationExample, InvestigationTaskOutput } from './types';

export const ROOT_CAUSE_EVALUATOR_NAME = 'root_cause_correct';

const referenceAnswerOf = ({
  output,
}: Pick<InvestigationExample, 'output'>): string | undefined => {
  const reference = output?.reference_answer;
  return typeof reference === 'string' && reference.trim() ? reference : undefined;
};

const rootCauseCriterion = (reference: string): string =>
  `The investigation's primary root cause (its conclusion, summary, or top-ranked hypothesis) ` +
  `identifies the same underlying cause as this reference answer: "${reference}". ` +
  `PASS when the causal mechanism matches, even if worded differently or less specific about ` +
  `secondary details. FAIL when it names a different cause, only restates symptoms, lists the ` +
  `reference cause merely as one of several unranked possibilities, or reaches no conclusion. ` +
  `Never answer N/A.`;

/** LLM judge scoring 1 when the investigation's root cause matches the example's reference answer. */
export const createRootCauseCorrectEvaluator = (
  evaluators: Pick<DefaultEvaluators, 'criteria'>
): Evaluator<InvestigationExample, InvestigationTaskOutput> => {
  const { getModel } = evaluators.criteria([]);
  return {
    name: ROOT_CAUSE_EVALUATOR_NAME,
    kind: 'LLM',
    direction: 'maximize',
    getModel,
    evaluate: async ({ input, output, expected, metadata }) => {
      const reference = referenceAnswerOf({ output: expected });
      if (!reference) {
        return {
          score: null,
          label: 'no_reference',
          explanation: 'Example has no reference_answer.',
        };
      }
      const { structured_report: report } = output;
      if (!report?.conclusion && !report?.summary) {
        return {
          score: 0,
          label: 'no_report',
          explanation: `No report to judge (workflow_status: ${
            output.workflow_status ?? 'unknown'
          }).`,
        };
      }
      const judged = await evaluators.criteria([rootCauseCriterion(reference)]).evaluate({
        input,
        output: report,
        expected,
        metadata,
      });
      const correct = judged.score === 1;
      return {
        ...judged,
        score: correct ? 1 : 0,
        label: correct ? 'correct' : 'incorrect',
      };
    },
  };
};

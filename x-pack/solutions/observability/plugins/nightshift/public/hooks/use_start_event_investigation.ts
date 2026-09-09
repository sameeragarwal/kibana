/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import { useMutation } from '@kbn/react-query';
import { MAX_TEXT_LENGTH } from '@kbn/significant-events-schema';
import { useKibana } from './use_kibana';

/** Synthetic subject so persist can record the run without binding it to a homepage event. */
export const HOMEPAGE_INVESTIGATION_SUBJECT_ID = 'homepage-prompt';

const START_SUCCESS_TOAST_TITLE = i18n.translate(
  'xpack.nightshift.homepagePrompt.investigationStartedToastTitle',
  {
    defaultMessage: 'Investigation started',
  }
);

const START_ERROR_TOAST_TITLE = i18n.translate(
  'xpack.nightshift.homepagePrompt.investigationFailedToastTitle',
  {
    defaultMessage: 'Failed to start investigation',
  }
);

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export interface StartHomepageInvestigationResponse {
  investigation_id: string;
}

interface UseStartEventInvestigationResult {
  startEventInvestigation: (message: string) => void;
  isStartingInvestigation: boolean;
}

export const useStartEventInvestigation = ({
  onStarted,
}: {
  onStarted?: (investigationId: string) => void;
} = {}): UseStartEventInvestigationResult => {
  const { http, notifications } = useKibana().services;

  const mutation = useMutation({
    mutationFn: (message: string) => {
      const trimmedMessage = message.trim().slice(0, MAX_TEXT_LENGTH);
      return http.post<StartHomepageInvestigationResponse>('/internal/nightshift/investigations', {
        body: JSON.stringify({
          subject: {
            type: 'significant_event',
            id: HOMEPAGE_INVESTIGATION_SUBJECT_ID,
            summary: trimmedMessage,
          },
          message: trimmedMessage,
        }),
      });
    },
    onSuccess: ({ investigation_id: investigationId }) => {
      notifications.toasts.addSuccess({ title: START_SUCCESS_TOAST_TITLE });
      onStarted?.(investigationId);
    },
    onError: (error: unknown) => {
      notifications.toasts.addError(toError(error), { title: START_ERROR_TOAST_TITLE });
    },
  });

  return {
    startEventInvestigation: (message) => mutation.mutate(message),
    isStartingInvestigation: mutation.isLoading,
  };
};

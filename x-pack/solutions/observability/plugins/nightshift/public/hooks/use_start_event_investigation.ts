/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import { useMutation, useQueryClient } from '@kbn/react-query';
import { MAX_TEXT_LENGTH } from '@kbn/significant-events-schema';
import { HOMEPAGE_INVESTIGATION_SUBJECT_ID } from '../common/constants';
import {
  addPendingHomepageInvestigationInCache,
  NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY,
} from './use_fetch_homepage_investigations';
import { useKibana } from './use_kibana';

export { HOMEPAGE_INVESTIGATION_SUBJECT_ID };

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
  const queryClient = useQueryClient();

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
    onSuccess: ({ investigation_id: investigationId }, message) => {
      addPendingHomepageInvestigationInCache(queryClient, {
        investigation_id: investigationId,
        status: 'pending',
        created_at: new Date().toISOString(),
        subject: {
          type: 'significant_event',
          id: HOMEPAGE_INVESTIGATION_SUBJECT_ID,
          summary: message.trim().slice(0, MAX_TEXT_LENGTH),
        },
      });
      void queryClient.invalidateQueries({ queryKey: NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY });
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

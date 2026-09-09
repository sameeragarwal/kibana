/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery, type UseQueryResult } from '@kbn/react-query';
import { useKibana } from './use_kibana';

export const NIGHTSHIFT_INVESTIGATION_QUERY_KEY = ['nightshift.investigation'] as const;

const RUNNING_INVESTIGATION_REFETCH_INTERVAL_MS = 5_000;

export const HOMEPAGE_INVESTIGATION_RECORD_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type HomepageInvestigationRecordStatus =
  (typeof HOMEPAGE_INVESTIGATION_RECORD_STATUSES)[number];

export interface HomepageInvestigationRecord {
  investigation_id: string;
  status: HomepageInvestigationRecordStatus;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  conversation_id?: string;
  error?: string;
  subject: {
    type: string;
    id: string;
    summary?: string;
  };
}

const isRunningRecordStatus = (status: HomepageInvestigationRecordStatus): boolean =>
  status === 'pending' || status === 'running';

export const useFetchInvestigation = (
  investigationId: string | undefined
): UseQueryResult<HomepageInvestigationRecord, Error> => {
  const { http } = useKibana().services;

  return useQuery<HomepageInvestigationRecord, Error>({
    queryKey: [...NIGHTSHIFT_INVESTIGATION_QUERY_KEY, investigationId],
    enabled: Boolean(investigationId),
    queryFn: ({ signal }) =>
      http.get<HomepageInvestigationRecord>(
        `/internal/nightshift/investigations/${investigationId}`,
        { signal }
      ),
    refetchInterval: (data) =>
      data && isRunningRecordStatus(data.status)
        ? RUNNING_INVESTIGATION_REFETCH_INTERVAL_MS
        : false,
  });
};

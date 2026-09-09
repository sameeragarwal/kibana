/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery, type QueryClient, type UseQueryResult } from '@kbn/react-query';
import { HOMEPAGE_INVESTIGATION_SUBJECT_ID } from '../common/constants';
import { useKibana } from './use_kibana';
import {
  isRunningHomepageInvestigationStatus,
  type HomepageInvestigationRecord,
} from './use_fetch_investigation';

export const NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY = [
  'nightshift.homepageInvestigations',
] as const;

const RUNNING_HOMEPAGE_INVESTIGATIONS_REFETCH_INTERVAL_MS = 5_000;
const HOMEPAGE_INVESTIGATIONS_PAGE_SIZE = 100;

interface HomepageInvestigationsListResponse {
  results: HomepageInvestigationRecord[];
  page: number;
  size: number;
  total: number;
}

const isHomepageInvestigation = (item: HomepageInvestigationRecord): boolean =>
  item.subject.id === HOMEPAGE_INVESTIGATION_SUBJECT_ID;

export const useFetchHomepageInvestigations = (): UseQueryResult<
  HomepageInvestigationRecord[],
  Error
> => {
  const { http } = useKibana().services;

  return useQuery<HomepageInvestigationRecord[], Error>({
    queryKey: NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await http.get<HomepageInvestigationsListResponse>(
        '/internal/nightshift/investigations',
        {
          query: {
            sort_field: 'created_at',
            sort_order: 'desc',
            size: HOMEPAGE_INVESTIGATIONS_PAGE_SIZE,
          },
          signal,
        }
      );

      return response.results.filter(isHomepageInvestigation);
    },
    refetchInterval: (data) =>
      data?.some((item) => isRunningHomepageInvestigationStatus(item.status))
        ? RUNNING_HOMEPAGE_INVESTIGATIONS_REFETCH_INTERVAL_MS
        : false,
  });
};

export const addPendingHomepageInvestigationInCache = (
  queryClient: QueryClient,
  investigation: HomepageInvestigationRecord
): void => {
  queryClient.setQueryData<HomepageInvestigationRecord[]>(
    NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY,
    (current) => {
      const existing = current ?? [];
      if (existing.some((item) => item.investigation_id === investigation.investigation_id)) {
        return existing;
      }
      return [investigation, ...existing];
    }
  );
};

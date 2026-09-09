/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { HOMEPAGE_INVESTIGATION_SUBJECT_ID } from '../common/constants';
import { useKibana } from './use_kibana';
import {
  addPendingHomepageInvestigationInCache,
  NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY,
  useFetchHomepageInvestigations,
} from './use_fetch_homepage_investigations';
import type { HomepageInvestigationRecord } from './use_fetch_investigation';

jest.mock('./use_kibana');

const mockUseKibana = useKibana as jest.Mock;
const httpGet = jest.fn();

const homepageInvestigation: HomepageInvestigationRecord = {
  investigation_id: 'homepage-exec-1',
  status: 'completed',
  created_at: '2026-09-04T22:06:55.578Z',
  subject: {
    type: 'significant_event',
    id: HOMEPAGE_INVESTIGATION_SUBJECT_ID,
    summary: 'Why did payment timeouts increase?',
  },
};

const eventInvestigation: HomepageInvestigationRecord = {
  investigation_id: 'event-exec-1',
  status: 'completed',
  created_at: '2026-09-04T21:00:00.000Z',
  subject: {
    type: 'significant_event',
    id: 'checkout-latency',
    summary: 'Checkout latency',
  },
};

describe('useFetchHomepageInvestigations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    httpGet.mockResolvedValue({
      results: [homepageInvestigation, eventInvestigation],
      page: 1,
      size: 100,
      total: 2,
    });
    mockUseKibana.mockReturnValue({
      services: { http: { get: httpGet } },
    });
  });

  it('loads homepage investigations and ignores event-bound runs', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useFetchHomepageInvestigations(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(httpGet).toHaveBeenCalledWith('/internal/nightshift/investigations', {
      query: {
        sort_field: 'created_at',
        sort_order: 'desc',
        size: 100,
      },
      signal: expect.any(AbortSignal),
    });
    expect(result.current.data).toEqual([homepageInvestigation]);
  });

  it('prepends a pending homepage investigation to the cache', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY, [homepageInvestigation]);

    const pending: HomepageInvestigationRecord = {
      investigation_id: 'homepage-exec-2',
      status: 'pending',
      created_at: '2026-09-09T19:00:00.000Z',
      subject: {
        type: 'significant_event',
        id: HOMEPAGE_INVESTIGATION_SUBJECT_ID,
        summary: 'Investigate last error',
      },
    };

    addPendingHomepageInvestigationInCache(queryClient, pending);

    expect(queryClient.getQueryData(NIGHTSHIFT_HOMEPAGE_INVESTIGATIONS_QUERY_KEY)).toEqual([
      pending,
      homepageInvestigation,
    ]);
  });
});

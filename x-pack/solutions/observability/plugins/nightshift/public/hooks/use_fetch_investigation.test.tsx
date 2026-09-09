/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { useKibana } from './use_kibana';
import { useFetchInvestigation, type HomepageInvestigationRecord } from './use_fetch_investigation';

jest.mock('./use_kibana');

const mockUseKibana = useKibana as jest.Mock;
const httpGet = jest.fn();

const investigation: HomepageInvestigationRecord = {
  investigation_id: 'exec-1',
  status: 'running',
  created_at: '2026-09-04T22:06:55.578Z',
  started_at: '2026-09-04T22:06:56.114Z',
  subject: {
    type: 'significant_event',
    id: 'homepage-prompt',
    summary: 'Why did payment timeouts increase?',
  },
};

describe('useFetchInvestigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    httpGet.mockResolvedValue(investigation);
    mockUseKibana.mockReturnValue({
      services: { http: { get: httpGet } },
    });
  });

  it('loads an investigation by id', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useFetchInvestigation('exec-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(httpGet).toHaveBeenCalledWith('/internal/nightshift/investigations/exec-1', {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.data).toEqual(investigation);
  });

  it('does not fetch when the id is missing', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useFetchInvestigation(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(httpGet).not.toHaveBeenCalled();
  });
});

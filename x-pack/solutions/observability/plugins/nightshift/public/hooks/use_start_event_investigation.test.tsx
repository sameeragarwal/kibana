/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { useKibana } from './use_kibana';
import {
  HOMEPAGE_INVESTIGATION_SUBJECT_ID,
  useStartEventInvestigation,
} from './use_start_event_investigation';

jest.mock('./use_kibana');

const mockUseKibana = useKibana as jest.Mock;
const httpPost = jest.fn();
const addSuccess = jest.fn();
const addError = jest.fn();

describe('useStartEventInvestigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    httpPost.mockResolvedValue({ investigation_id: 'exec-1' });
    mockUseKibana.mockReturnValue({
      services: {
        http: { post: httpPost },
        notifications: {
          toasts: { addError, addSuccess },
        },
      },
    });
  });

  it('starts an investigation with the typed message and no event subject', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const onStarted = jest.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useStartEventInvestigation({ onStarted }), { wrapper });

    act(() => result.current.startEventInvestigation('Why did payment timeouts increase?'));

    await waitFor(() => expect(addSuccess).toHaveBeenCalled());

    expect(httpPost).toHaveBeenCalledWith(
      '/internal/nightshift/investigations',
      expect.objectContaining({
        body: JSON.stringify({
          subject: {
            type: 'significant_event',
            id: HOMEPAGE_INVESTIGATION_SUBJECT_ID,
            summary: 'Why did payment timeouts increase?',
          },
          message: 'Why did payment timeouts increase?',
        }),
      })
    );
    expect(onStarted).toHaveBeenCalledWith('exec-1');
  });

  it('toasts when the investigation cannot start', async () => {
    httpPost.mockRejectedValue(new Error('unavailable'));
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useStartEventInvestigation(), { wrapper });

    act(() => result.current.startEventInvestigation('Investigate this'));

    await waitFor(() => expect(addError).toHaveBeenCalled());
    expect(addSuccess).not.toHaveBeenCalled();
  });
});

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { EuiProvider } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import type { UseInvestigationStateResult } from '@kbn/investigation-output';
import { HomepageInvestigationFlyout } from './homepage_investigation_flyout';
import { useFetchInvestigation } from '../hooks/use_fetch_investigation';

jest.mock('@kbn/kibana-react-plugin/public', () => ({
  useUiSetting: () => 'MMM D, YYYY @ HH:mm:ss.SSS',
}));

const mockOpenChat = jest.fn();
const mockUseInvestigationState = jest.fn<UseInvestigationStateResult, [unknown]>();

jest.mock('@kbn/investigation-output', () => ({
  useInvestigationState: (args: unknown) => mockUseInvestigationState(args),
}));

jest.mock('../hooks/use_fetch_investigation');
jest.mock('../hooks/use_kibana', () => ({
  useKibana: () => ({
    services: {
      agentBuilder: { openChat: mockOpenChat },
      http: {},
      notifications: { toasts: { addSuccess: jest.fn() } },
      share: { url: { locators: { get: () => undefined } } },
    },
  }),
}));

const mockUseFetchInvestigation = useFetchInvestigation as jest.Mock;

const renderFlyout = (
  props: Partial<React.ComponentProps<typeof HomepageInvestigationFlyout>> = {}
) => {
  const onClose = jest.fn();
  const onNotFound = jest.fn();
  const view = render(
    <I18nProvider>
      <EuiProvider>
        <HomepageInvestigationFlyout
          investigationId="exec-1"
          onClose={onClose}
          onNotFound={onNotFound}
          {...props}
        />
      </EuiProvider>
    </I18nProvider>
  );

  return { ...view, onClose, onNotFound };
};

describe('HomepageInvestigationFlyout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseInvestigationState.mockReturnValue({
      status: 'running',
      state: { summary: 'Looking at payment timeouts.' },
    });
    mockUseFetchInvestigation.mockReturnValue({
      data: {
        investigation_id: 'exec-1',
        status: 'running',
        created_at: '2026-09-04T22:06:55.578Z',
        started_at: '2026-09-04T22:06:56.114Z',
        subject: {
          type: 'significant_event',
          id: 'homepage-prompt',
          summary: 'Why did payment timeouts increase?',
        },
      },
      isError: false,
      isFetched: true,
      isLoading: false,
    });
  });

  it('shows the typed prompt and live investigation progress', () => {
    renderFlyout();

    expect(screen.getByTestId('nightshiftHomepageInvestigationFlyout')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Why did payment timeouts increase?' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('nightshiftInvestigationSummaryCard')).toBeInTheDocument();
    expect(screen.getByTestId('nightshiftInvestigationHeadline')).toHaveTextContent(
      'Looking at payment timeouts.'
    );
    expect(mockUseInvestigationState).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowExecutionId: 'exec-1',
        isRunning: true,
      })
    );
  });

  it('opens the investigation conversation when chat is available', () => {
    mockUseInvestigationState.mockReturnValue({
      status: 'complete',
      conversationId: 'conv-1',
      state: { summary: 'Payment timeouts came from a bad deploy.' },
    });
    mockUseFetchInvestigation.mockReturnValue({
      data: {
        investigation_id: 'exec-1',
        status: 'completed',
        created_at: '2026-09-04T22:06:55.578Z',
        started_at: '2026-09-04T22:06:56.114Z',
        completed_at: '2026-09-04T22:08:00.000Z',
        subject: {
          type: 'significant_event',
          id: 'homepage-prompt',
          summary: 'Why did payment timeouts increase?',
        },
      },
      isError: false,
      isFetched: true,
      isLoading: false,
    });

    renderFlyout();

    fireEvent.click(screen.getByTestId('nightshiftHomepageInvestigationFlyoutChatButton'));
    expect(mockOpenChat).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('reports a missing investigation so the URL can be cleared', () => {
    mockUseFetchInvestigation.mockReturnValue({
      data: undefined,
      isError: true,
      isFetched: true,
      isLoading: false,
    });

    const { onNotFound } = renderFlyout();

    expect(onNotFound).toHaveBeenCalledWith('exec-1');
    expect(screen.queryByTestId('nightshiftHomepageInvestigationFlyout')).not.toBeInTheDocument();
  });
});

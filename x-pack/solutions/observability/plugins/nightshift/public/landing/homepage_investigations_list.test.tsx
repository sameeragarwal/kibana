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
import { HOMEPAGE_INVESTIGATION_SUBJECT_ID } from '../common/constants';
import type { HomepageInvestigationRecord } from '../hooks/use_fetch_investigation';
import { HomepageInvestigationsList } from './homepage_investigations_list';

const homepageInvestigation = (
  overrides: Partial<HomepageInvestigationRecord> = {}
): HomepageInvestigationRecord => ({
  investigation_id: 'homepage-exec-1',
  status: 'completed',
  created_at: '2026-09-04T22:06:55.578Z',
  subject: {
    type: 'significant_event',
    id: HOMEPAGE_INVESTIGATION_SUBJECT_ID,
    summary: 'Why did payment timeouts increase?',
  },
  ...overrides,
});

const renderList = (
  props: Partial<React.ComponentProps<typeof HomepageInvestigationsList>> = {}
) => {
  const onInvestigationClick = jest.fn();
  const view = render(
    <I18nProvider>
      <EuiProvider>
        <HomepageInvestigationsList
          investigations={[homepageInvestigation()]}
          onInvestigationClick={onInvestigationClick}
          {...props}
        />
      </EuiProvider>
    </I18nProvider>
  );

  return { ...view, onInvestigationClick };
};

describe('HomepageInvestigationsList', () => {
  it('renders nothing when there are no investigations', () => {
    renderList({ investigations: [] });

    expect(screen.queryByTestId('nightshiftHomepageInvestigationsList')).not.toBeInTheDocument();
  });

  it('renders past runs and opens one on click', () => {
    const { onInvestigationClick } = renderList();

    expect(screen.getByText('Recent investigations')).toBeInTheDocument();
    expect(screen.getByText('Why did payment timeouts increase?')).toBeInTheDocument();

    const row = screen.getByTestId('nightshiftHomepageInvestigationItem');
    expect(row).toHaveAttribute('data-ebt-action', 'viewInvestigation');
    expect(row).toHaveAttribute('data-ebt-element', 'nightshiftHomepageInvestigationsList');

    fireEvent.click(row);
    expect(onInvestigationClick).toHaveBeenCalledWith('homepage-exec-1');
  });

  it('opens a run with Enter and Space', () => {
    const { onInvestigationClick } = renderList();
    const row = screen.getByTestId('nightshiftHomepageInvestigationItem');

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onInvestigationClick).toHaveBeenCalledTimes(2);
    expect(onInvestigationClick).toHaveBeenCalledWith('homepage-exec-1');
  });
});

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { css } from '@emotion/react';
import React from 'react';
import {
  EuiBadge,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiText,
  EuiTitle,
  useEuiTheme,
} from '@elastic/eui';
import { getEbtProps } from '@kbn/ebt-click';
import { i18n } from '@kbn/i18n';
import { FormattedMessage, FormattedRelative } from '@kbn/i18n-react';
import { NIGHTSHIFT_EBT_ACTIONS, NIGHTSHIFT_EBT_ELEMENTS } from '../common/ebt_constants';
import { toHomepageInvestigationWorkflowStatus } from '../common/investigation_progress_status';
import { nightshiftBackgroundTransition } from '../common/transition';
import type { HomepageInvestigationRecord } from '../hooks/use_fetch_investigation';
import { InvestigationStatusBadge } from '../investigation/investigation_status_badge';

export interface HomepageInvestigationsListProps {
  investigations: HomepageInvestigationRecord[];
  onInvestigationClick: (investigationId: string) => void;
  selectedInvestigationId?: string;
}

const untitledInvestigationLabel = i18n.translate(
  'xpack.nightshift.homepageInvestigations.untitledLabel',
  {
    defaultMessage: 'Investigation',
  }
);

export function HomepageInvestigationsList({
  investigations,
  onInvestigationClick,
  selectedInvestigationId,
}: HomepageInvestigationsListProps): React.ReactElement | null {
  const { euiTheme } = useEuiTheme();

  if (investigations.length === 0) {
    return null;
  }

  return (
    <section
      data-test-subj="nightshiftHomepageInvestigationsList"
      css={css`
        align-self: stretch;
        margin-top: ${euiTheme.size.l};
        width: 100%;
      `}
    >
      <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiTitle
            size="xs"
            css={css`
              font-weight: ${euiTheme.font.weight.medium};
            `}
          >
            <h2>
              <FormattedMessage
                id="xpack.nightshift.homepageInvestigations.recentTitle"
                defaultMessage="Recent investigations"
              />
            </h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiBadge color="hollow">{investigations.length}</EuiBadge>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiPanel
        hasBorder
        hasShadow={false}
        paddingSize="none"
        css={css`
          box-sizing: border-box;
          margin-top: ${euiTheme.size.s};
          overflow: hidden;
          border-radius: ${euiTheme.size.s};
        `}
      >
        <ol
          css={css`
            list-style: none;
            margin: 0;
            padding: 0;
          `}
        >
          {investigations.map((investigation, index) => {
            const prompt = investigation.subject.summary?.trim() || untitledInvestigationLabel;
            const isSelected = investigation.investigation_id === selectedInvestigationId;

            return (
              <li
                key={investigation.investigation_id}
                css={
                  index < investigations.length - 1
                    ? css`
                        border-bottom: ${euiTheme.border.thin};
                      `
                    : undefined
                }
              >
                <div
                  aria-label={i18n.translate(
                    'xpack.nightshift.homepageInvestigations.rowAriaLabel',
                    {
                      defaultMessage: 'Open investigation: {prompt}',
                      values: { prompt },
                    }
                  )}
                  data-test-subj="nightshiftHomepageInvestigationItem"
                  data-investigation-id={investigation.investigation_id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => onInvestigationClick(investigation.investigation_id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) {
                      return;
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onInvestigationClick(investigation.investigation_id);
                    }
                  }}
                  {...getEbtProps({
                    action: NIGHTSHIFT_EBT_ACTIONS.VIEW_INVESTIGATION,
                    element: NIGHTSHIFT_EBT_ELEMENTS.HOMEPAGE_INVESTIGATIONS_LIST,
                  })}
                  css={css`
                    background: ${isSelected
                      ? euiTheme.colors.backgroundBaseInteractiveSelect
                      : euiTheme.colors.backgroundBasePlain};
                    cursor: pointer;
                    padding: ${euiTheme.size.m};
                    transition: ${nightshiftBackgroundTransition(euiTheme)};

                    &:hover {
                      background: ${isSelected
                        ? euiTheme.colors.backgroundBaseInteractiveSelect
                        : euiTheme.colors.backgroundBaseSubdued};
                    }
                  `}
                >
                  <EuiFlexGroup
                    alignItems="center"
                    gutterSize="s"
                    justifyContent="spaceBetween"
                    responsive={false}
                  >
                    <EuiFlexItem grow={false}>
                      <InvestigationStatusBadge
                        event={{
                          investigations: [
                            {
                              workflow_execution_id: investigation.investigation_id,
                              started_at: investigation.started_at ?? investigation.created_at,
                            },
                          ],
                        }}
                        investigationStatus={toHomepageInvestigationWorkflowStatus(
                          investigation.status
                        )}
                      />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued">
                        <FormattedRelative value={investigation.created_at} />
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiText
                    className="eui-textTruncate"
                    component="p"
                    size="s"
                    css={css`
                      font-weight: ${euiTheme.font.weight.medium};
                      margin: ${euiTheme.size.xs} 0 0;
                    `}
                  >
                    {prompt}
                  </EuiText>
                </div>
              </li>
            );
          })}
        </ol>
      </EuiPanel>
    </section>
  );
}

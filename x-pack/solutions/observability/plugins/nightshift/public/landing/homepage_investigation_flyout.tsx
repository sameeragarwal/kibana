/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { css } from '@emotion/react';
import React, { useCallback, useEffect, useMemo } from 'react';
import {
  EuiBadge,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
  useEuiTheme,
} from '@elastic/eui';
import { getEbtProps } from '@kbn/ebt-click';
import { useInvestigationState } from '@kbn/investigation-output';
import { i18n } from '@kbn/i18n';
import { AiButton } from '@kbn/shared-ux-ai-components';
import { buildInvestigationConversationChatOptions } from '../chat/open_significant_event_in_chat';
import { FlyoutSectionTitle } from '../common/flyout_section_title';
import { useFlyoutShareUrlCustomAction } from '../common/flyout_share_url_button';
import { setFlyoutMenuCloseButtonEbtProps } from '../common/flyout_close_ebt';
import { useFormatTimestamp } from '../common/format_timestamp';
import { TruncatableSummary } from '../common/truncatable_summary';
import { buildNightshiftInvestigationFlyoutShareUrl } from '../common/url_params';
import {
  NIGHTSHIFT_EBT_ACTIONS,
  NIGHTSHIFT_EBT_DETAILS,
  NIGHTSHIFT_EBT_ELEMENTS,
} from '../common/ebt_constants';
import { EventInvestigation } from '../event/event_investigation';
import { useFetchInvestigation } from '../hooks/use_fetch_investigation';
import { useKibana } from '../hooks/use_kibana';

export interface HomepageInvestigationFlyoutProps {
  investigationId: string;
  onClose: () => void;
  onNotFound: (investigationId: string) => void;
}

const fallbackTitle = i18n.translate('xpack.nightshift.homepageInvestigation.fallbackTitle', {
  defaultMessage: 'Investigation',
});

const typeBadgeLabel = i18n.translate('xpack.nightshift.homepageInvestigation.typeBadgeLabel', {
  defaultMessage: 'Investigation',
});

const openInChatLabel = i18n.translate('xpack.nightshift.flyout.openInChatButtonLabel', {
  defaultMessage: 'Open in chat',
});

const investigationChatUnavailableLabel = i18n.translate(
  'xpack.nightshift.flyout.openInChatInvestigationUnavailable',
  {
    defaultMessage: 'Investigation chat is still loading',
  }
);

const promptSectionTitle = i18n.translate('xpack.nightshift.homepageInvestigation.promptTitle', {
  defaultMessage: 'Prompt',
});

export function HomepageInvestigationFlyout({
  investigationId,
  onClose,
  onNotFound,
}: HomepageInvestigationFlyoutProps): React.ReactElement | null {
  const { euiTheme } = useEuiTheme();
  const formatTimestamp = useFormatTimestamp();
  const { agentBuilder, http } = useKibana().services;
  const investigationQuery = useFetchInvestigation(investigationId);
  const investigation = investigationQuery.data;

  useEffect(() => {
    if (investigationQuery.isFetched && (investigationQuery.isError || !investigation)) {
      onNotFound(investigationId);
    }
  }, [
    investigation,
    investigationId,
    investigationQuery.isError,
    investigationQuery.isFetched,
    onNotFound,
  ]);

  const isRecordRunning =
    investigation == null ||
    (investigation.completed_at == null &&
      investigation.status !== 'failed' &&
      investigation.status !== 'cancelled');

  const {
    conversationId,
    error: investigationError,
    state: investigationState,
    status: investigationStatus,
  } = useInvestigationState({
    http,
    workflowExecutionId: investigationId,
    isRunning: isRecordRunning,
  });

  const title = investigation?.subject.summary?.trim() || fallbackTitle;
  const startedAt = investigation?.started_at ?? investigation?.created_at;
  const mappedInvestigation = useMemo(
    () =>
      investigation && startedAt
        ? {
            workflow_execution_id: investigation.investigation_id,
            started_at: startedAt,
            completed_at: investigation.completed_at,
          }
        : undefined,
    [investigation, startedAt]
  );

  const getShareUrl = useCallback(
    () => buildNightshiftInvestigationFlyoutShareUrl(investigationId),
    [investigationId]
  );
  const shareUrlCustomAction = useFlyoutShareUrlCustomAction(getShareUrl);
  const flyoutMenuProps = useMemo(
    () => ({
      title,
      hideTitle: true,
      customActions: [shareUrlCustomAction],
    }),
    [shareUrlCustomAction, title]
  );

  const handleOpenInChat = useCallback(() => {
    if (!conversationId) {
      return;
    }
    agentBuilder?.openChat(buildInvestigationConversationChatOptions(conversationId));
  }, [agentBuilder, conversationId]);

  if (investigationQuery.isFetched && (investigationQuery.isError || !investigation)) {
    return null;
  }

  return (
    <EuiFlyout
      onClose={onClose}
      size="s"
      type="push"
      session="start"
      resizable
      aria-label={title}
      flyoutMenuProps={flyoutMenuProps}
      data-test-subj="nightshiftHomepageInvestigationFlyout"
      onClickCapture={(clickEvent: React.MouseEvent<HTMLElement>) =>
        setFlyoutMenuCloseButtonEbtProps(
          clickEvent,
          NIGHTSHIFT_EBT_ELEMENTS.HOMEPAGE_INVESTIGATION_FLYOUT
        )
      }
    >
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="s">
          <h2>{title}</h2>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
          <EuiFlexItem grow={false}>
            <EuiBadge color="default">{typeBadgeLabel}</EuiBadge>
          </EuiFlexItem>
        </EuiFlexGroup>
        {startedAt && (
          <>
            <EuiSpacer size="s" />
            <EuiText size="xs" color="subdued">
              {formatTimestamp(startedAt)}
            </EuiText>
          </>
        )}
      </EuiFlyoutHeader>

      <EuiFlyoutBody>
        {investigationQuery.isLoading || !investigation || !mappedInvestigation ? (
          <EuiFlexGroup justifyContent="center">
            <EuiFlexItem grow={false}>
              <EuiLoadingSpinner data-test-subj="nightshiftHomepageInvestigationFlyoutLoading" />
            </EuiFlexItem>
          </EuiFlexGroup>
        ) : (
          <>
            <FlyoutSectionTitle>{promptSectionTitle}</FlyoutSectionTitle>
            <EuiSpacer size="s" />
            <TruncatableSummary summary={title} />

            <EuiSpacer size="l" />

            <EventInvestigation
              title={title}
              investigation={mappedInvestigation}
              status={investigationStatus}
              state={investigationState}
              error={investigationError}
              conversationId={conversationId}
            />
          </>
        )}
      </EuiFlyoutBody>

      {agentBuilder && mappedInvestigation && (
        <EuiFlyoutFooter
          css={css`
            background: ${euiTheme.colors.backgroundBasePlain};
            border-top: ${euiTheme.border.thin};
          `}
        >
          <EuiFlexGroup justifyContent="flexEnd" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiToolTip content={conversationId ? undefined : investigationChatUnavailableLabel}>
                <span tabIndex={conversationId ? undefined : 0}>
                  <AiButton
                    variant="empty"
                    size="s"
                    iconType="productAgent"
                    iconSide="left"
                    data-test-subj="nightshiftHomepageInvestigationFlyoutChatButton"
                    disabled={!conversationId}
                    onClick={handleOpenInChat}
                    {...getEbtProps({
                      action: NIGHTSHIFT_EBT_ACTIONS.OPEN_IN_CHAT,
                      element: NIGHTSHIFT_EBT_ELEMENTS.HOMEPAGE_INVESTIGATION_FLYOUT,
                      detail: NIGHTSHIFT_EBT_DETAILS.EXISTING_CONVERSATION,
                    })}
                  >
                    {openInChatLabel}
                  </AiButton>
                </span>
              </EuiToolTip>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlyoutFooter>
      )}
    </EuiFlyout>
  );
}

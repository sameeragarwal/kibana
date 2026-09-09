/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { css } from '@emotion/react';
import React, { useCallback, useState } from 'react';
import {
  EuiButtonIcon,
  EuiToolTip,
  keys,
  useEuiFontSize,
  useEuiShadow,
  useEuiTheme,
} from '@elastic/eui';
import { getEbtProps } from '@kbn/ebt-click';
import { i18n } from '@kbn/i18n';
import { MAX_TEXT_LENGTH } from '@kbn/significant-events-schema';
import { NIGHTSHIFT_EBT_ACTIONS, NIGHTSHIFT_EBT_ELEMENTS } from '../common/ebt_constants';

export interface HomepagePromptProps {
  isSubmitting?: boolean;
  onInvestigate: (message: string) => void;
}

const placeholder = i18n.translate('xpack.nightshift.homepagePrompt.inputPlaceholder', {
  defaultMessage: 'Ask about a service, deployment, or metric...',
});

const inputAriaLabel = i18n.translate('xpack.nightshift.homepagePrompt.inputAriaLabel', {
  defaultMessage: 'Investigate',
});

const submitButtonLabel = i18n.translate('xpack.nightshift.homepagePrompt.submitButtonLabel', {
  defaultMessage: 'Investigate',
});

export function HomepagePrompt({
  isSubmitting = false,
  onInvestigate,
}: HomepagePromptProps): React.ReactElement {
  const { euiTheme } = useEuiTheme();
  const textFont = useEuiFontSize('m');
  const restShadow = useEuiShadow('s');
  const [message, setMessage] = useState('');

  const trimmedMessage = message.trim();
  const isSubmitDisabled = trimmedMessage.length === 0 || isSubmitting;

  const submit = useCallback(() => {
    if (isSubmitDisabled) {
      return;
    }

    onInvestigate(trimmedMessage);
    setMessage('');
  }, [isSubmitDisabled, onInvestigate, trimmedMessage]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === keys.ENTER && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-test-subj="nightshiftHomepagePrompt"
      css={css`
        align-self: stretch;
        margin-top: ${euiTheme.size.m};
        width: 100%;
      `}
    >
      <div
        aria-label={inputAriaLabel}
        data-test-subj="nightshiftHomepagePromptShell"
        css={css`
          background: ${isSubmitting
            ? euiTheme.colors.backgroundBaseDisabled
            : euiTheme.colors.backgroundBasePlain};
          border: ${euiTheme.border.width.thin} solid ${euiTheme.colors.borderBaseSubdued};
          border-radius: ${euiTheme.size.l};
          display: flex;
          flex-direction: column;
          gap: ${euiTheme.size.s};
          padding: ${euiTheme.size.m};
          transition: border-color 180ms ease, box-shadow 180ms ease;
          ${restShadow}

          &:focus-within {
            border-color: ${euiTheme.colors.borderBasePrimary};
          }
        `}
      >
        <textarea
          aria-label={inputAriaLabel}
          data-test-subj="nightshiftHomepagePromptInput"
          disabled={isSubmitting}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          rows={3}
          value={message}
          css={css`
            ${textFont}
            background: transparent;
            border: none;
            color: ${euiTheme.colors.textParagraph};
            cursor: text;
            font-family: inherit;
            min-height: calc(${euiTheme.size.xl} * 2);
            outline: none;
            resize: none;
            width: 100%;

            &::placeholder {
              color: ${euiTheme.colors.textDisabled};
            }

            &:focus:focus-visible {
              outline-style: none;
            }
          `}
        />
        <div
          css={css`
            display: flex;
            justify-content: flex-end;
          `}
        >
          <EuiToolTip content={submitButtonLabel} disableScreenReaderOutput>
            <EuiButtonIcon
              aria-label={submitButtonLabel}
              color="text"
              data-test-subj="nightshiftHomepagePromptSubmitButton"
              disabled={isSubmitDisabled}
              display="base"
              iconType="sortUp"
              isLoading={isSubmitting}
              onClick={submit}
              size="s"
              css={css`
                border-radius: 50%;
              `}
              {...getEbtProps({
                action: NIGHTSHIFT_EBT_ACTIONS.START_HOMEPAGE_INVESTIGATION,
                element: NIGHTSHIFT_EBT_ELEMENTS.HOMEPAGE_PROMPT,
              })}
            />
          </EuiToolTip>
        </div>
      </div>
    </div>
  );
}

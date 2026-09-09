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
import { HomepagePrompt } from './homepage_prompt';

const renderPrompt = (props: Partial<React.ComponentProps<typeof HomepagePrompt>> = {}) => {
  const onInvestigate = jest.fn();
  const view = render(
    <I18nProvider>
      <EuiProvider>
        <HomepagePrompt onInvestigate={onInvestigate} {...props} />
      </EuiProvider>
    </I18nProvider>
  );

  return { ...view, onInvestigate };
};

describe('HomepagePrompt', () => {
  it('starts an investigation on submit', () => {
    const { onInvestigate } = renderPrompt();

    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('nightshiftHomepagePromptInput'), {
      target: { value: 'Why did checkout latency spike?' },
    });
    fireEvent.click(screen.getByTestId('nightshiftHomepagePromptSubmitButton'));

    expect(onInvestigate).toHaveBeenCalledWith('Why did checkout latency spike?');
    expect(screen.getByTestId('nightshiftHomepagePromptInput')).toHaveValue('');
  });

  it('submits on Enter and keeps a newline on Shift+Enter', () => {
    const { onInvestigate } = renderPrompt();
    const input = screen.getByTestId('nightshiftHomepagePromptInput');

    fireEvent.change(input, { target: { value: 'Investigate last error' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onInvestigate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInvestigate).toHaveBeenCalledWith('Investigate last error');
  });

  it('disables submit until the prompt has text', () => {
    const { onInvestigate } = renderPrompt();

    expect(screen.getByTestId('nightshiftHomepagePromptSubmitButton')).toBeDisabled();

    fireEvent.click(screen.getByTestId('nightshiftHomepagePromptSubmitButton'));
    expect(onInvestigate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('nightshiftHomepagePromptInput'), {
      target: { value: 'Investigate last error' },
    });

    expect(screen.getByTestId('nightshiftHomepagePromptSubmitButton')).toBeEnabled();
  });
});

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiButtonIcon, EuiFlexGroup, EuiFlexItem, EuiText, EuiToolTip } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import React from 'react';
import type { VoicePhase } from '../voice_session';

const startLabel = i18n.translate(
  'xpack.agentBuilder.conversationInput.inputActions.startVoiceConversationLabel',
  { defaultMessage: 'Start voice conversation' }
);

const stopLabel = i18n.translate(
  'xpack.agentBuilder.conversationInput.inputActions.stopVoiceConversationLabel',
  { defaultMessage: 'End voice conversation' }
);

const phaseLabels: Record<Exclude<VoicePhase, 'idle'>, string> = {
  listening: i18n.translate('xpack.agentBuilder.conversationInput.inputActions.voiceListening', {
    defaultMessage: 'Listening…',
  }),
  transcribing: i18n.translate(
    'xpack.agentBuilder.conversationInput.inputActions.voiceTranscribing',
    { defaultMessage: 'Transcribing…' }
  ),
  thinking: i18n.translate('xpack.agentBuilder.conversationInput.inputActions.voiceThinking', {
    defaultMessage: 'Thinking…',
  }),
  speaking: i18n.translate('xpack.agentBuilder.conversationInput.inputActions.voiceSpeaking', {
    defaultMessage: 'Speaking…',
  }),
};

// EUI has no microphone glyph.
const MicrophoneIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="currentColor"
    {...props}
  >
    <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1ZM6.5 3.5a1.5 1.5 0 1 1 3 0v4a1.5 1.5 0 1 1-3 0v-4Z" />
    <path d="M3.5 6.5A.5.5 0 0 1 4 7a4 4 0 0 0 8 0 .5.5 0 0 1 1 0 5 5 0 0 1-4.5 4.975V14H10a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1h1.5v-2.025A5 5 0 0 1 3 7a.5.5 0 0 1 .5-.5Z" />
  </svg>
);

interface VoiceConversationButtonProps {
  phase: VoicePhase;
  onToggle: () => void;
}

export const VoiceConversationButton: React.FC<VoiceConversationButtonProps> = ({
  phase,
  onToggle,
}) => {
  const isActive = phase !== 'idle';
  const label = isActive ? stopLabel : startLabel;
  return (
    <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
      <EuiFlexItem grow={false}>
        <EuiText size="xs" color="subdued" aria-live="polite">
          {isActive ? phaseLabels[phase] : null}
        </EuiText>
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <EuiToolTip content={label} disableScreenReaderOutput>
          <EuiButtonIcon
            iconType={MicrophoneIcon}
            color={isActive ? 'danger' : 'text'}
            display={isActive ? 'base' : 'empty'}
            size="s"
            aria-label={label}
            aria-pressed={isActive}
            data-test-subj="agentBuilderConversationInputVoiceButton"
            onClick={onToggle}
          />
        </EuiToolTip>
      </EuiFlexItem>
    </EuiFlexGroup>
  );
};

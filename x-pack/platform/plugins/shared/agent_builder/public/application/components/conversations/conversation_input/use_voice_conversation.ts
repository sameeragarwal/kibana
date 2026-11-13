/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ConversationRound, ExecutionStepEvent } from '@kbn/agent-builder-common';
import {
  ConversationRoundStatus,
  isReasoningStep,
  isToolCallStep,
  TimelineEventType,
} from '@kbn/agent-builder-common';
import { useLiveEvents } from '../../../hooks/use_live_events';
import type { TimelineDisplayEvent } from '../../../../services/events';
import { toPromptSpeechText, toSpeechText, toStepSpeechText } from './to_speech_text';
import type { NarrateRequestBody } from '../../../../../common/http_api/voice';
import type { SynthesizeSpeech } from './speech_player';
import type { VoiceError, VoicePhase } from './voice_session';
import { isVoiceConversationSupported, voiceSession } from './voice_session';

const isStepEvent = (event: TimelineDisplayEvent): event is ExecutionStepEvent =>
  event.type === TimelineEventType.executionStep;

// A run that fails or is stopped can end without a completed round to read out.
const NO_REPLY_TIMEOUT_MS = 20_000;

interface UseVoiceConversationOptions {
  enabled: boolean;
  conversationId: string | undefined;
  rounds: ConversationRound[] | undefined;
  isResponseLoading: boolean;
  transcribe: (audio: string, signal: AbortSignal) => Promise<string>;
  synthesize: SynthesizeSpeech;
  narrate: (request: NarrateRequestBody, signal: AbortSignal) => Promise<string>;
  send: (message: string) => boolean;
  onError: (error: VoiceError) => void;
  onNoReply: () => void;
}

interface UseVoiceConversation {
  isAvailable: boolean;
  phase: VoicePhase;
  toggle: () => void;
  stop: () => void;
}

/** Hands-free chat: sends what the user says and reads the agent's reply aloud. */
export const useVoiceConversation = ({
  enabled,
  conversationId,
  rounds,
  isResponseLoading,
  transcribe,
  synthesize,
  narrate,
  send,
  onError,
  onNoReply,
}: UseVoiceConversationOptions): UseVoiceConversation => {
  const isAvailable = useMemo(() => enabled && isVoiceConversationSupported(), [enabled]);
  const phase = useSyncExternalStore(voiceSession.subscribe, voiceSession.getPhase);
  const roundIds = useMemo(() => rounds?.map(({ id }) => id) ?? [], [rounds]);
  const roundIdsRef = useRef(roundIds);
  roundIdsRef.current = roundIds;
  const callbacksRef = useRef({ transcribe, synthesize, narrate, send, onError, onNoReply });
  callbacksRef.current = { transcribe, synthesize, narrate, send, onError, onNoReply };

  useEffect(() => {
    if (!isAvailable) return;
    return voiceSession.bind({
      transcribe: (audio, signal) => callbacksRef.current.transcribe(audio, signal),
      synthesize: (text, signal) => callbacksRef.current.synthesize(text, signal),
      narrate: (request, signal) => callbacksRef.current.narrate(request, signal),
      send: (message) => {
        voiceSession.markHandled(roundIdsRef.current);
        return callbacksRef.current.send(message);
      },
      onError: (error) => callbacksRef.current.onError(error),
    });
  }, [isAvailable]);

  // Replies that finished while the user wasn't waiting on one (the session was off, or they were
  // listening or speaking) are on screen already, so they are never read out later.
  useEffect(() => {
    if (phase !== 'thinking') voiceSession.markHandled(roundIds);
  }, [phase, roundIds]);

  // Switching to another conversation ends the session, so its rounds are never mistaken for the
  // reply. Creating a conversation (no id yet, then an id) keeps it going.
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    const previousId = conversationIdRef.current;
    conversationIdRef.current = conversationId;
    if (previousId && previousId !== conversationId) voiceSession.stop();
  }, [conversationId]);

  // Reads out the agent's progress messages streamed for the current run. Steps already
  // streamed before the user spoke belong to an earlier run.
  const liveEvents = useLiveEvents();
  const earlierStepIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const stepEvents = liveEvents.filter(isStepEvent);
    if (phase !== 'thinking') {
      stepEvents.forEach(({ id }) => earlierStepIdsRef.current.add(id));
      return;
    }
    if (!isAvailable) return;
    stepEvents
      .filter(({ id }) => !earlierStepIdsRef.current.has(id))
      .forEach(({ data: { step } }) => {
        if (isReasoningStep(step) && !step.transient) {
          voiceSession.addActivity(toSpeechText(step.reasoning));
        } else if (isToolCallStep(step) && step.intent) {
          voiceSession.addActivity(toStepSpeechText(step.intent));
        }
      });
  }, [isAvailable, phase, liveEvents]);

  useEffect(() => {
    if (!isAvailable || phase !== 'thinking' || isResponseLoading) return;

    const lastRound = rounds?.at(-1);
    if (lastRound && voiceSession.isAwaitedReply(lastRound.id)) {
      if (lastRound.status === ConversationRoundStatus.completed) {
        const { message } = lastRound.response;
        voiceSession.speakReply(
          lastRound.id,
          { markdown: message, text: toSpeechText(message) },
          { thenListen: true }
        );
        return;
      }
      if (lastRound.status === ConversationRoundStatus.awaitingPrompt) {
        voiceSession.speakReply(
          lastRound.id,
          { text: toPromptSpeechText(lastRound.pending_prompts) },
          { thenListen: false }
        );
        return;
      }
    }

    const timeoutId = setTimeout(() => {
      if (voiceSession.getPhase() !== 'thinking') return;
      voiceSession.stop();
      callbacksRef.current.onNoReply();
    }, NO_REPLY_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, [isAvailable, phase, isResponseLoading, rounds]);

  const toggle = useCallback(() => {
    if (voiceSession.getPhase() === 'idle') {
      voiceSession.start();
    } else {
      voiceSession.stop();
    }
  }, []);

  const stop = useCallback(() => voiceSession.stop(), []);

  return { isAvailable, phase, toggle, stop };
};

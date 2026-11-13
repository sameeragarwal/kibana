/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type { AskUserQuestionItem, PromptRequest } from '@kbn/agent-builder-common/agents';
import { isAskUserQuestionPrompt, isConfirmationPrompt } from '@kbn/agent-builder-common/agents';

const MAX_SPOKEN_LENGTH = 800;

const onScreenOnly = i18n.translate('xpack.agentBuilder.conversationInput.voice.onScreenOnly', {
  defaultMessage: 'The answer is on screen.',
});

const restOnScreen = i18n.translate('xpack.agentBuilder.conversationInput.voice.restOnScreen', {
  defaultMessage: 'The details are on screen.',
});

const stripInlineMarkdown = (line: string): string =>
  line
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/(\*\*|\*|`)/g, '')
    // Reads identifiers such as service_name as words, and drops underscore emphasis.
    .replace(/_+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

const endSentence = (text: string): string => (/[.!?:]$/.test(text) ? text : `${text}.`);

/**
 * Turns an agent's markdown reply into text worth hearing: prose only, tables and code left
 * on screen, cut at a sentence boundary when long.
 */
export const toSpeechText = (markdown: string): string => {
  let skippedVisualContent = false;
  const withoutCode = markdown.replace(/```[\s\S]*?(```|$)/g, () => {
    skippedVisualContent = true;
    return '\n';
  });

  const spokenLines = withoutCode.split('\n').flatMap((line) => {
    if (/^\s*\|/.test(line)) {
      skippedVisualContent = true;
      return [];
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return [];
    const text = stripInlineMarkdown(line);
    return text ? [endSentence(text)] : [];
  });

  let spoken = spokenLines.join(' ');
  if (spoken.length > MAX_SPOKEN_LENGTH) {
    const cut = spoken.slice(0, MAX_SPOKEN_LENGTH);
    const lastSentenceEnd = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('! ')
    );
    spoken = lastSentenceEnd > 0 ? cut.slice(0, lastSentenceEnd + 1) : cut;
    skippedVisualContent = true;
  }

  if (!spoken) return onScreenOnly;
  return skippedVisualContent ? `${spoken} ${restOnScreen}` : spoken;
};

const TIME_UNITS: Readonly<Record<string, string>> = {
  s: 'seconds',
  m: 'minutes',
  h: 'hours',
  d: 'days',
};

/** Turns a tool call's short intent ("Errors per service, last 15m") into a spoken sentence. */
export const toStepSpeechText = (intent: string): string =>
  endSentence(
    // Index patterns are read by name: "logs-*" is spoken as "logs".
    stripInlineMarkdown(intent.replace(/-\*/g, ''))
      .replace(
        /\b(\d+)\s?([smhd])\b/g,
        (match, amount: string, unit: string) => `${amount} ${TIME_UNITS[unit]}`
      )
      .replace(/\s*\/\s*/g, ' and ')
      .trim()
  );

const answerOnScreen = i18n.translate('xpack.agentBuilder.conversationInput.voice.answerOnScreen', {
  defaultMessage: 'Answer on screen to continue.',
});

const readQuestion = ({ question, options }: AskUserQuestionItem): string => {
  const text = endSentence(stripInlineMarkdown(question));
  if (options.length === 0) return text;
  return i18n.translate('xpack.agentBuilder.conversationInput.voice.questionWithOptions', {
    defaultMessage: '{question} The options are: {options}.',
    values: { question: text, options: options.map(({ label }) => label).join(', ') },
  });
};

/** Reads out what the agent is waiting for, then asks the user to answer on screen. */
export const toPromptSpeechText = (prompts: PromptRequest[] | undefined = []): string => {
  const spoken = prompts.flatMap((prompt) => {
    if (isAskUserQuestionPrompt(prompt)) return prompt.questions.map(readQuestion);
    if (isConfirmationPrompt(prompt)) {
      return [prompt.title, prompt.message]
        .map((text) => (text ? stripInlineMarkdown(text) : ''))
        .filter(Boolean)
        .map(endSentence);
    }
    return [];
  });
  return [...spoken, answerOnScreen].join(' ');
};

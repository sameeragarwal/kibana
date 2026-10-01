/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { latencySummary, MatrixCell, SweepRow, TreeDiagnostics } from './matrix';

interface Results {
  cases: Array<{
    case_id: string;
    tree_id?: string;
    generative_goal_pass?: number | null;
    generative_duration_ms?: number;
  }>;
  trees: TreeDiagnostics[];
  sweep: SweepRow[];
  latency: ReturnType<typeof latencySummary>;
}

const pct = (value: number | undefined): string =>
  value === undefined ? '-' : `${Math.round(value * 100)}%`;
const ms = (value: number | undefined): string =>
  value === undefined
    ? '-'
    : value >= 10_000
    ? `${(value / 1000).toFixed(0)}s`
    : `${Math.round(value)}ms`;
const short = (caseId: string): string =>
  caseId.replace(/^customer0-/, '').replace(/-2026-.*$/, '');

/** Renders results.json as a short markdown report. */
export const renderSummary = (results: Results, cells: MatrixCell[]): string => {
  const lines: string[] = ['# Jev tree-as-code replay', ''];

  lines.push('## Trees learned by exploration', '');
  lines.push(
    '| case | nodes | branch points | gold path | gold terminal | gold terminal goal_pass | generative goal_pass | generative time |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of results.cases) {
    const tree = results.trees.find(({ case_id: id }) => id === c.case_id);
    lines.push(
      `| ${short(c.case_id)} | ${tree?.nodes ?? '-'} | ${tree?.branching_nodes ?? '-'} | ${
        tree?.gold_path_length ?? '-'
      } | ${tree?.gold_terminal ?? '-'} | ${
        tree?.gold_verdict ? `${tree.gold_verdict.raw_score}/5` : '-'
      } | ${
        c.generative_goal_pass == null ? '-' : `${Math.round(c.generative_goal_pass * 4 + 1)}/5`
      } | ${ms(c.generative_duration_ms)} |`
    );
  }

  lines.push('', '## Threshold sweep', '');
  lines.push(
    'Diagonal = each tree on its own incident (should resolve correctly). Off-diagonal = each tree on the other incidents (should escalate). Margin 0.1 above threshold 0.',
    ''
  );
  lines.push(
    '| chooser | symptom gate | none rule | T | diag coverage | diag selective acc | diag accuracy | gold terminal agreement | off-diag false resolution | off-diag escalation recall |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of results.sweep) {
    lines.push(
      `| ${row.chooser} | ${row.symptom_gate ? 'on' : 'off'} | ${row.none_rule} | ${
        row.threshold
      } | ${pct(row.diagonal_coverage)} | ${pct(row.diagonal_selective_accuracy)} | ${pct(
        row.diagonal_accuracy
      )} | ${pct(row.diagonal_gold_terminal_agreement)} | ${pct(
        row.off_diagonal_false_resolution_rate
      )} | ${pct(row.off_diagonal_escalation_recall)} |`
    );
  }

  const { latency } = results;
  lines.push('', '## Latency', '');
  lines.push(
    '| chooser | per call p50 | per call p95 | calls | per walk p50 | per walk p95 | tokens |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, call] of Object.entries(latency.per_call_ms)) {
    const walk = latency.walk_ms[name];
    lines.push(
      `| ${name} | ${ms(call.p50)} | ${ms(call.p95)} | ${call.calls} | ${ms(walk?.p50)} | ${ms(
        walk?.p95
      )} | ${latency.tokens[name] ?? '-'} |`
    );
  }
  lines.push(
    '',
    `Generative investigation (exploration run): p50 ${ms(latency.generative_ms.p50)}, p95 ${ms(
      latency.generative_ms.p95
    )}.`
  );

  lines.push('', '## Branch agreement with exploration (diagonal, gate off, entry_only, T=0)', '');
  lines.push(
    'Of the branch points on the gold path that the walk reached, how often the chooser took the edge exploration took. Isolates branch selection from tree quality.',
    ''
  );
  lines.push('| chooser | agreed / reached | first divergence per case |');
  lines.push('| --- | --- | --- |');
  const agreementCells = cells.filter(
    ({ diagonal, symptom_gate: gate, none_rule: rule }) =>
      diagonal && !gate && rule === 'entry_only'
  );
  for (const chooser of [...new Set(agreementCells.map((cell) => cell.chooser))]) {
    let agreed = 0;
    let reached = 0;
    const divergences: string[] = [];
    for (const cell of agreementCells.filter((c) => c.chooser === chooser)) {
      const { gold_path: gold } = cell;
      let divergedAt: string | undefined;
      for (const { node_id: id, options, taken } of cell.walk.hops) {
        const goldIndex = gold.indexOf(id);
        if (goldIndex < 0 || goldIndex === gold.length - 1) continue;
        reached++;
        const target = options.find(({ key }) => key === taken)?.target_node_id;
        if (target === gold[goldIndex + 1]) {
          agreed++;
        } else {
          divergedAt = id;
          break;
        }
      }
      divergences.push(`${short(cell.incident_case_id).slice(0, 24)}: ${divergedAt ?? 'none'}`);
    }
    lines.push(`| ${chooser} | ${agreed}/${reached} | ${divergences.join('; ')} |`);
  }

  lines.push('', '## Diagonal walks (T=0, symptom gate on, none rule every_hop)', '');
  for (const cell of cells.filter(
    ({ diagonal, symptom_gate: gate, none_rule: rule }) => diagonal && gate && rule === 'every_hop'
  )) {
    const { walk } = cell;
    const hops = walk.hops
      .map(({ node_id: id, decision, taken }) => {
        const best = taken ? decision.probabilities[taken] : undefined;
        return `${id}:${
          taken ? `${taken}@${best?.toFixed(2)}` : 'none'
        }(none=${decision.none_probability.toFixed(2)})`;
      })
      .join(' ');
    lines.push(
      `- **${cell.chooser}** ${short(cell.incident_case_id)}: ${walk.outcome}${
        walk.terminal_label ? ` -> "${walk.terminal_label}"` : ` (${walk.escalation_reason})`
      }${cell.verdict ? `, goal ${cell.verdict.raw_score}/5` : ''}, gold terminal ${
        cell.matches_gold_terminal ? 'matched' : 'not matched'
      }, evidence missing ${walk.evidence_missing}. Hops: ${hops}`
    );
  }
  lines.push('');
  return lines.join('\n');
};

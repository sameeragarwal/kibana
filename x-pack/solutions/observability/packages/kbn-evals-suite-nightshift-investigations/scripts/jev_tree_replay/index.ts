/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { run } from '@kbn/dev-cli-runner';
import { compileTree, emitTreeModule } from './compile_tree';
import { exportFixtures } from './export_fixtures';
import { createJevChooser, readJevApiKey } from './jev_client';
import { DEFAULT_SCOUT_KIBANA, createLlmChooser } from './kibana_client';
import { latencySummary, runMatrix, sweep } from './matrix';
import { renderSummary } from './summary';
import type { BranchChooser, CaseFixture, CompiledTree } from './types';

const FIXTURE_SUFFIX = '.json';
const RESERVED = new Set(['results.json', 'walks.json']);

const readFixtures = (dir: string): CaseFixture[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(FIXTURE_SUFFIX) && !RESERVED.has(file))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as CaseFixture);

run(
  async ({ flagsReader, log }) => {
    const step = flagsReader.string('step') ?? 'all';
    const outDir = flagsReader.string('out') ?? '/tmp/ns_eval/jev';
    const connectorId =
      flagsReader.string('connector') ?? '.anthropic-claude-4.6-sonnet-chat_completion';
    const chooserNames = (flagsReader.string('choosers') ?? 'jev,llm').split(',');

    if (step === 'export' || step === 'all') {
      await exportFixtures({
        target: DEFAULT_SCOUT_KIBANA,
        logPath: flagsReader.string('log') ?? join(outDir, 'explore_run.log'),
        examplesPath: flagsReader.string('examples') ?? '/tmp/ns_eval/customer0_top5.json',
        outDir,
        log,
      });
    }
    if (step === 'export') return;

    const fixtures = readFixtures(outDir);
    const compiled = new Map<string, CompiledTree>();
    mkdirSync(join(outDir, 'compiled'), { recursive: true });
    for (const fixture of fixtures) {
      if (!fixture.tree) {
        log.warning(`${fixture.case_id}: no decision tree; it is an incident only, not a tree`);
        continue;
      }
      const tree = compileTree(fixture.tree);
      compiled.set(fixture.case_id, tree);
      writeFileSync(join(outDir, 'compiled', `${fixture.case_id}.ts`), emitTreeModule(tree));
      log.info(
        `${fixture.case_id}: ${tree.view.nodes.length} nodes, gold path ${tree.goldPath.join(
          ' > '
        )}`
      );
    }
    if (step === 'compile') return;

    const choosers: Record<string, BranchChooser> = {};
    if (chooserNames.includes('jev')) choosers.jev = createJevChooser(readJevApiKey());
    if (chooserNames.includes('llm')) {
      choosers.llm = createLlmChooser(DEFAULT_SCOUT_KIBANA, connectorId);
    }

    const { cells, trees } = await runMatrix({
      fixtures,
      compiled,
      choosers,
      target: DEFAULT_SCOUT_KIBANA,
      judgeConnectorId: connectorId,
      log,
    });
    writeFileSync(join(outDir, 'walks.json'), JSON.stringify(cells, null, 2));
    const results = {
      generated_at: new Date().toISOString(),
      cases: fixtures.map(
        ({ case_id: caseId, generative_scores: scores, generative_duration_ms: ms, tree }) => ({
          case_id: caseId,
          tree_id: tree?.tree_id,
          generative_goal_pass: scores.goal_pass,
          generative_duration_ms: ms,
        })
      ),
      trees,
      sweep: sweep(cells),
      latency: latencySummary(cells, fixtures),
    };
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    writeFileSync(join(outDir, 'summary.md'), renderSummary(results, cells));
    log.success(`Wrote ${join(outDir, 'results.json')} and summary.md`);
  },
  {
    description: `
      Replays Nightshift investigations through their learned decision trees, compiled to code,
      with Jev (TypeSafe System One) or a generative model choosing each branch.

      Steps: export (snapshot exploration runs from the Scout Kibana), compile, all (default).
    `,
    flags: {
      string: ['step', 'out', 'log', 'examples', 'connector', 'choosers'],
      help: `
        --step       export | compile | all (default all)
        --out        Fixture and results directory (default /tmp/ns_eval/jev)
        --log        Exploration eval log to read run ids from (default <out>/explore_run.log)
        --examples   Examples file the exploration run used
        --connector  Inference connector for the judge and the generative chooser
        --choosers   Comma-separated: jev,llm (default both)
      `,
    },
  }
);

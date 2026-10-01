/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  extractMermaid,
  parseStoredDecisionTree,
  type DecisionEdgeView,
  type DecisionNodeView,
  type DecisionTreeView,
} from '@kbn/nightshift-decision-trees';
import type { CaseTree, CompiledTree, EdgeOption } from './types';

export const outgoingEdges = (view: DecisionTreeView, nodeId: string): DecisionEdgeView[] =>
  view.edges.filter(({ source_node_id: source }) => source === nodeId);

export const nodeById = (view: DecisionTreeView, nodeId: string): DecisionNodeView | undefined =>
  view.nodes.find(({ node_id: id }) => id === nodeId);

/** Symptom nodes with no incoming edge; the entry points of a walk. */
export const symptomRoots = (view: DecisionTreeView): DecisionNodeView[] => {
  const targets = new Set(view.edges.map(({ target_node_id: target }) => target));
  const roots = view.nodes.filter(({ node_id: id }) => !targets.has(id));
  const symptoms = roots.filter(({ node_type: type }) => type === 'symptom');
  return symptoms.length > 0 ? symptoms : roots;
};

/** Turns a node's outgoing edges into chooser options; bare edges fall back to the target label. */
export const edgeOptions = (view: DecisionTreeView, nodeId: string): EdgeOption[] =>
  outgoingEdges(view, nodeId).map(({ target_node_id: target, condition }, index) => ({
    key: `edge_${index}`,
    target_node_id: target,
    condition:
      condition && condition !== 'next'
        ? condition
        : `Proceed to: ${nodeById(view, target)?.label ?? target}`,
  }));

// Exploration only reliably marks branching edges; a node's sole edge is often left unmarked.
const takenEdge = (view: DecisionTreeView, nodeId: string): DecisionEdgeView | undefined => {
  const edges = outgoingEdges(view, nodeId);
  const targets = new Set(edges.map(({ target_node_id: target }) => target));
  const taken = edges.find(({ is_taken: isTaken }) => isTaken);
  return taken ?? (targets.size === 1 ? edges[0] : undefined);
};

const walkGoldPath = (view: DecisionTreeView): string[] => {
  const roots = symptomRoots(view);
  const takenRoot =
    roots.find(({ node_id: id }) => outgoingEdges(view, id).some(({ is_taken: taken }) => taken)) ??
    (roots.length === 1 ? roots[0] : undefined);
  if (!takenRoot) return [];
  const path = [takenRoot.node_id];
  let current = takenRoot.node_id;
  while (path.length <= view.nodes.length) {
    const next = takenEdge(view, current);
    if (!next || path.includes(next.target_node_id)) break;
    path.push(next.target_node_id);
    current = next.target_node_id;
  }
  return path;
};

/** Parses a stored tree into an executable graph and records the path exploration took. */
export const compileTree = (tree: CaseTree): CompiledTree => {
  const view = parseStoredDecisionTree(
    extractMermaid(tree.markdown),
    tree.tree_id,
    tree.evidence_gatherer_metadata
  );
  return { tree_id: tree.tree_id, view, goldPath: walkGoldPath(view) };
};

const literal = (value: string): string => JSON.stringify(value);

const emitNode = (view: DecisionTreeView, node: DecisionNodeView): string => {
  const { node_id: id, node_type: type, label } = node;
  const header = `// ${id} [${type}] ${label}`;
  const options = edgeOptions(view, id);
  if (options.length === 0) {
    const body =
      type === 'end'
        ? `ctx.resolve(${literal(id)}, ${literal(label)})`
        : `ctx.escalate(${literal(id)}, 'dead_end')`;
    return `${header}\nconst ${id} = async (ctx: TreeContext): Promise<TreeOutcome> => ${body};`;
  }
  const gather =
    type === 'evidence_gatherer'
      ? `  await ctx.gather(${literal(id)}, ${literal(label)}, ${literal(
          node.node_metadata?.description ?? ''
        )});\n`
      : '';
  if (options.length === 1) {
    return `${header}\nconst ${id} = async (ctx: TreeContext): Promise<TreeOutcome> => {\n${gather}  return ${options[0].target_node_id}(ctx);\n};`;
  }
  const choices = options
    .map(({ key, condition }) => `    ${key}: ${literal(condition)},`)
    .join('\n');
  const branches = options
    .map(
      ({ key, target_node_id: target }) =>
        `  if (answer === ${literal(key)}) return ${target}(ctx);`
    )
    .join('\n');
  return [
    header,
    `const ${id} = async (ctx: TreeContext): Promise<TreeOutcome> => {`,
    `${gather}  const answer = await ctx.choose(${literal(id)}, ${literal(label)}, {`,
    choices,
    '  });',
    branches,
    `  return ctx.escalate(${literal(id)}, 'low_confidence');`,
    '};',
  ].join('\n');
};

/**
 * Emits the tree as a readable TypeScript module: one function per node, real `if` statements
 * for every branch, and the classifier behind `ctx.choose`. The replay interprets the same graph
 * directly; this rendering exists so a reviewer can see exactly what was compiled.
 */
export const emitTreeModule = ({ tree_id: treeId, view }: CompiledTree): string => {
  const roots = symptomRoots(view);
  const entry =
    roots.length === 1
      ? `  return ${roots[0].node_id}(ctx);`
      : [
          `  const symptom = await ctx.choose('entry', 'Which symptom does this alert describe?', {`,
          ...roots.map(({ node_id: id, label }) => `    ${id}: ${literal(label)},`),
          '  });',
          ...roots.map(({ node_id: id }) => `  if (symptom === ${literal(id)}) return ${id}(ctx);`),
          `  return ctx.escalate('entry', 'symptom_mismatch');`,
        ].join('\n');
  return [
    `// Compiled from decision tree ${treeId}. Generated; do not edit.\nimport type { TreeContext, TreeOutcome } from './tree_context';`,
    ...view.nodes.map((node) => emitNode(view, node)),
    `export const run = async (ctx: TreeContext): Promise<TreeOutcome> => {\n${entry}\n};\n`,
  ].join('\n\n');
};

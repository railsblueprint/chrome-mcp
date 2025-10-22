/**
 * Copyright (c) 404 Software Labs.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Snapshot Formatter
 *
 * Processes raw accessibility tree from CDP into structured, truncated format.
 * This reduces data transfer from ~12MB raw to ~100KB structured JSON.
 */

interface AXNode {
  nodeId: string;
  parentId?: string;
  role?: { type: string; value: string | number };
  name?: { type: string; value: string };
  value?: { type: string; value: string | number };
  childIds?: string[];
  backendDOMNodeId?: number;
  chromeRole?: { type: string; value: number };
  ignored?: boolean;
}

interface TreeNode extends AXNode {
  children: TreeNode[];
}

export interface FormattedNode {
  role: string;
  name?: string;
  value?: string;
  selectorHint?: string;
  children?: FormattedNode[];
  isGroupSummary?: boolean;
  groupCount?: number;
}

export interface FormattedSnapshot {
  nodes: FormattedNode[];
  totalLines: number;
  truncated: boolean;
  truncationMessage?: string;
}

/**
 * Format raw CDP accessibility tree into structured, truncated snapshot
 */
export function formatAccessibilitySnapshot(
  rawSnapshot: { nodes: AXNode[] },
  maxLines: number = 200
): FormattedSnapshot {
  const nodes = rawSnapshot.nodes || [];

  // Build tree from flat array
  const nodeMap = new Map<string, TreeNode>();

  // First pass: index all nodes by ID
  for (const node of nodes) {
    nodeMap.set(node.nodeId, { ...node, children: [] });
  }

  // Second pass: build parent-child relationships
  let rootNode: TreeNode | null = null;
  for (const node of nodeMap.values()) {
    if (node.parentId) {
      const parent = nodeMap.get(node.parentId);
      if (parent) {
        parent.children.push(node);
      }
    } else {
      rootNode = node;
    }
  }

  if (!rootNode) {
    return {
      nodes: [],
      totalLines: 0,
      truncated: false
    };
  }

  // Process tree: collapse, group, format
  collapseTree(rootNode);
  const totalLines = { count: 0 };
  const formatted = formatTree([rootNode], 0, totalLines, maxLines);

  return {
    nodes: formatted,
    totalLines: totalLines.count,
    truncated: totalLines.count >= maxLines,
    truncationMessage: totalLines.count >= maxLines
      ? `Snapshot truncated at ${maxLines} lines to save bandwidth`
      : undefined
  };
}

/**
 * Recursively collapse useless wrapper nodes (none/generic with no text)
 */
function collapseTree(node: TreeNode): void {
  // Recursively collapse children first (bottom-up)
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      collapseTree(child);
    }
  }

  // Collapse useless single-child chains
  const role = node.role?.value || 'unknown';
  const name = node.name?.value || '';
  const isUseless = (role === 'none' || role === 'generic' || role === 'unknown') && !name;

  if (isUseless && node.children && node.children.length === 1) {
    // Promote the single child
    const child = node.children[0];
    node.role = child.role;
    node.name = child.name;
    node.value = child.value;
    node.children = child.children || [];

    // Recursively collapse again
    collapseTree(node);
  }
}

/**
 * Generate CSS selector hint for interactive elements
 */
function generateSelectorHint(role: string, name?: string, value?: string): string | undefined {
  const interactiveRoles = ['textbox', 'combobox', 'searchbox', 'spinbutton'];

  if (!interactiveRoles.includes(role)) {
    return undefined;
  }

  // Provide generic hint - we can't reliably suggest selectors from ARIA tree alone
  return 'CSS: #id, input[type="..."], or input[name="..."]';
}

/**
 * Format tree nodes into structured output with grouping and truncation
 */
function formatTree(
  nodes: TreeNode[],
  depth: number,
  totalLines: { count: number },
  maxLines: number
): FormattedNode[] {
  if (!nodes || nodes.length === 0 || totalLines.count >= maxLines) {
    return [];
  }

  // Limit root level nodes to prevent massive trees
  const nodesToProcess = depth === 0 ? nodes.slice(0, 100) : nodes;
  const result: FormattedNode[] = [];

  // Group consecutive nodes with same role
  const groups = groupByRole(nodesToProcess);

  for (const group of groups) {
    if (totalLines.count >= maxLines) break;

    if (group.nodes.length === 1) {
      // Single node - format normally
      const node = group.nodes[0];
      const name = node.name?.value?.toString() || '';
      const value = node.value?.value?.toString() || '';
      const selectorHint = generateSelectorHint(group.role, name, value);

      const formatted: FormattedNode = {
        role: group.role,
        name: name || undefined,
        value: value || undefined,
        selectorHint: selectorHint || undefined
      };

      totalLines.count++;

      if (node.children && node.children.length > 0 && totalLines.count < maxLines) {
        formatted.children = formatTree(node.children, depth + 1, totalLines, maxLines);
      }

      result.push(formatted);
    } else {
      // Multiple nodes with same role - show first 2, skip middle, show last 1
      const first = group.nodes.slice(0, 2);
      const last = group.nodes.slice(-1);
      const skippedCount = group.nodes.length - 3;

      // Add first 2
      for (const node of first) {
        if (totalLines.count >= maxLines) break;

        const name = node.name?.value?.toString() || '';
        const value = node.value?.value?.toString() || '';
        const selectorHint = generateSelectorHint(group.role, name, value);

        const formatted: FormattedNode = {
          role: group.role,
          name: name || undefined,
          value: value || undefined,
          selectorHint: selectorHint || undefined
        };

        totalLines.count++;

        if (node.children && node.children.length > 0 && totalLines.count < maxLines) {
          formatted.children = formatTree(node.children, depth + 1, totalLines, maxLines);
        }

        result.push(formatted);
      }

      // Add skip message for significant repetition (10+ elements)
      if (totalLines.count < maxLines && skippedCount >= 10) {
        result.push({
          role: group.role,
          isGroupSummary: true,
          groupCount: skippedCount
        });
        totalLines.count++;
      }

      // Add last 1
      for (const node of last) {
        if (totalLines.count >= maxLines) break;

        const name = node.name?.value?.toString() || '';
        const value = node.value?.value?.toString() || '';
        const selectorHint = generateSelectorHint(group.role, name, value);

        const formatted: FormattedNode = {
          role: group.role,
          name: name || undefined,
          value: value || undefined,
          selectorHint: selectorHint || undefined
        };

        totalLines.count++;

        if (node.children && node.children.length > 0 && totalLines.count < maxLines) {
          formatted.children = formatTree(node.children, depth + 1, totalLines, maxLines);
        }

        result.push(formatted);
      }
    }
  }

  return result;
}

/**
 * Group consecutive nodes with same role
 */
function groupByRole(nodes: TreeNode[]): Array<{ role: string; nodes: TreeNode[] }> {
  if (nodes.length === 0) return [];

  const groups: Array<{ role: string; nodes: TreeNode[] }> = [];
  let currentGroup: { role: string; nodes: TreeNode[] } | null = null;

  for (const node of nodes) {
    const role = node.role?.value?.toString() || 'unknown';

    if (!currentGroup || currentGroup.role !== role) {
      // Start new group
      currentGroup = { role, nodes: [node] };
      groups.push(currentGroup);
    } else {
      // Add to current group
      currentGroup.nodes.push(node);
    }
  }

  return groups;
}

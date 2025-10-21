#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read the saved snapshot
const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshot-raw-debug.json')));

// Build tree from flat array
const nodes = rawData.nodes || [];
const nodeMap = new Map();

// First pass: index all nodes by ID
for (const node of nodes) {
  nodeMap.set(node.nodeId, { ...node, children: [] });
}

// Second pass: build parent-child relationships
let rootNode = null;
for (const node of nodeMap.values()) {
  if (node.parentId) {
    const parent = nodeMap.get(node.parentId);
    if (parent) {
      parent.children.push(node);
    }
  } else {
    rootNode = node; // This is the root (no parent)
  }
}

// Clean tree function
function cleanTree(node) {
  // Recursively clean children first
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      cleanTree(child);
    }

    // Remove empty/useless children
    node.children = node.children.filter(child => {
      const role = child.role?.value || 'unknown';
      const name = child.name?.value || '';

      // Remove empty none/generic with no children
      if ((role === 'none' || role === 'generic') && !name && (!child.children || child.children.length === 0)) {
        return false;
      }

      // Remove buttons/links with only images that have no description
      if (role === 'button' || role === 'link') {
        // If it has a name, keep it
        if (name) return true;

        // If no name and no children, remove it
        if (!child.children || child.children.length === 0) {
          return false;
        }

        // If no name, check if all children are images without descriptions
        const hasOnlyUselessImages = child.children.every(c => {
          const childRole = c.role?.value || '';
          const childName = c.name?.value || '';
          return childRole === 'image' && !childName;
        });
        if (hasOnlyUselessImages) return false;
      }

      // Remove InlineTextBox children (they duplicate parent StaticText)
      if (role === 'InlineTextBox' || role === 'inlineTextBox') {
        return false;
      }

      // Remove images with no description (no alt text, no aria-label)
      if (role === 'image' && !name) {
        return false;
      }

      // Remove LabelText with no content
      if (role === 'LabelText' && !name && (!child.children || child.children.length === 0)) {
        return false;
      }

      return true;
    });
  }
}

// Collapse tree function
function collapseTree(node) {
  // Recursively collapse children first (bottom-up)
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      collapseTree(child);
    }
  }

  // Collapse useless single-child chains
  // If this node is "none"/"generic" with no text and only 1 child, skip it
  const role = node.role?.value || 'unknown';
  const name = node.name?.value || '';
  const isUseless = (role === 'none' || role === 'generic' || role === 'unknown') && !name;

  if (isUseless && node.children && node.children.length === 1) {
    // Promote the single child: replace this node's children with grandchildren
    const child = node.children[0];
    node.role = child.role;
    node.name = child.name;
    node.children = child.children || [];

    // Recursively collapse again in case we created another collapsible chain
    collapseTree(node);
  }
}

// Format tree function
function formatAXTree(nodes, depth = 0, totalLines = { count: 0 }, maxLines = 200) {
  if (!nodes || nodes.length === 0) return '';
  if (totalLines.count >= maxLines) return '';

  let output = '';
  const indent = '  '.repeat(depth);

  // Group consecutive nodes by role to detect repetitive patterns
  const groups = [];
  let currentGroup = null;

  for (const node of nodes.slice(0, 100)) { // Process first 100 at each level
    const role = node.role?.value || 'unknown';

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { role, nodes: [node] };
    } else {
      currentGroup.nodes.push(node);
    }
  }
  if (currentGroup) groups.push(currentGroup);

  // Format output with deduplication
  for (const group of groups) {
    if (totalLines.count >= maxLines) break;

    if (group.nodes.length <= 3) {
      // Show all if 3 or fewer
      for (const node of group.nodes) {
        if (totalLines.count >= maxLines) break;

        const name = node.name?.value || '';
        output += `${indent}${group.role}${name ? `: ${name}` : ''}\n`;
        totalLines.count++;

        if (node.children && totalLines.count < maxLines) {
          output += formatAXTree(node.children, depth + 1, totalLines, maxLines);
        }
      }
    } else {
      // Repetitive pattern: show first 2, skip middle, show last 1
      const first = group.nodes.slice(0, 2);
      const last = group.nodes.slice(-1);
      const skippedCount = group.nodes.length - 3;

      for (const node of first) {
        if (totalLines.count >= maxLines) break;

        const name = node.name?.value || '';
        output += `${indent}${group.role}${name ? `: ${name}` : ''}\n`;
        totalLines.count++;

        if (node.children && totalLines.count < maxLines) {
          output += formatAXTree(node.children, depth + 1, totalLines, maxLines);
        }
      }

      // Only show skip message for significant repetition (10+ elements)
      if (totalLines.count < maxLines && skippedCount >= 10) {
        output += `${indent}... ${skippedCount} more ${group.role} element${skippedCount > 1 ? 's' : ''} skipped\n`;
        totalLines.count++;
      }

      for (const node of last) {
        if (totalLines.count >= maxLines) break;

        const name = node.name?.value || '';
        output += `${indent}${group.role}${name ? `: ${name}` : ''}\n`;
        totalLines.count++;

        if (node.children && totalLines.count < maxLines) {
          output += formatAXTree(node.children, depth + 1, totalLines, maxLines);
        }
      }
    }
  }

  // Show truncation info at root level
  if (depth === 0) {
    if (totalLines.count >= maxLines) {
      output += `\n--- Snapshot truncated at ${maxLines} lines to save context ---\n`;
    }
    if (nodes.length > 100) {
      output += `\n(Processed first 100 elements at root level, ${nodes.length - 100} more not shown)\n`;
    }
  }

  return output;
}

// Process the tree
if (rootNode) {
  console.log('Processing tree...');
  cleanTree(rootNode);
  collapseTree(rootNode);
  cleanTree(rootNode); // Second pass

  const snapshot = formatAXTree([rootNode]);

  console.log('\n### Page Snapshot\n');
  console.log(snapshot);

  // Save to file
  fs.writeFileSync(path.join(__dirname, 'snapshot-test-local.txt'), `### Page Snapshot\n\n${snapshot}`);
  console.log('\n[Saved to snapshot-test-local.txt]');
} else {
  console.error('No root node found!');
}

import type { ConnectionGroup, SSHConnection } from '../../shared/types';

export interface ConnectionGroupTreeNode {
  group: ConnectionGroup;
  depth: number;
  children: ConnectionGroupTreeNode[];
  directConnections: SSHConnection[];
  totalConnections: number;
}

function sortGroups(groups: ConnectionGroup[]): ConnectionGroup[] {
  return [...groups].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
  );
}

/**
 * 构建支持多级嵌套的连接分组树；自动断开非法/循环 parentId，防止死循环。
 */
export function buildConnectionGroupTree(
  groups: ConnectionGroup[],
  connections: SSHConnection[],
): {
  roots: ConnectionGroupTreeNode[];
  ungrouped: SSHConnection[];
} {
  const sorted = sortGroups(groups);
  const byId = new Map(sorted.map((group) => [group.id, group]));
  const childrenByParent = new Map<string | null, ConnectionGroup[]>();

  // 检测并打破环路：沿 parentId 向上回溯，命中自己或已访问节点则视为根分组
  const resolveSafeParent = (group: ConnectionGroup): string | null => {
    const rawParent = group.parentId || null;
    if (!rawParent || !byId.has(rawParent) || rawParent === group.id) return null;
    const seen = new Set<string>([group.id]);
    let cursor: string | undefined = rawParent;
    while (cursor) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId;
    }
    return rawParent;
  };

  for (const group of sorted) {
    const parent = resolveSafeParent(group);
    const list = childrenByParent.get(parent) || [];
    list.push(group);
    childrenByParent.set(parent, list);
  }

  const connectionsByGroup = new Map<string, SSHConnection[]>();
  const ungrouped: SSHConnection[] = [];
  for (const conn of connections) {
    if (conn.groupId && byId.has(conn.groupId)) {
      const list = connectionsByGroup.get(conn.groupId) || [];
      list.push(conn);
      connectionsByGroup.set(conn.groupId, list);
    } else {
      ungrouped.push(conn);
    }
  }

  const buildNode = (group: ConnectionGroup, depth: number): ConnectionGroupTreeNode => {
    const directConnections = connectionsByGroup.get(group.id) || [];
    const childGroups = childrenByParent.get(group.id) || [];
    const children = childGroups.map((child) => buildNode(child, depth + 1));
    const totalConnections = directConnections.length + children.reduce((sum, child) => sum + child.totalConnections, 0);
    return {
      group,
      depth,
      children,
      directConnections,
      totalConnections,
    };
  };

  const roots = (childrenByParent.get(null) || []).map((group) => buildNode(group, 0));
  return { roots, ungrouped };
}

/** 展平分组树为「层级路径」选项列表（如 `生产 / 华东 / DB`），便于下拉框选择。 */
export function flattenGroupOptions(
  groups: ConnectionGroup[],
  excludeGroupId?: string,
): Array<{ id: string; label: string; depth: number }> {
  const sorted = sortGroups(groups);
  const byId = new Map(sorted.map((g) => [g.id, g]));

  // 收集 excludeGroupId 及其所有后代，编辑分组时不能选自己或子孙做父分组
  const excluded = new Set<string>();
  if (excludeGroupId) {
    excluded.add(excludeGroupId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of sorted) {
        if (!excluded.has(g.id) && g.parentId && excluded.has(g.parentId)) {
          excluded.add(g.id);
          changed = true;
        }
      }
    }
  }

  const { roots } = buildConnectionGroupTree(sorted, []);
  const out: Array<{ id: string; label: string; depth: number }> = [];
  const visit = (node: ConnectionGroupTreeNode, trail: string[]) => {
    if (excluded.has(node.group.id)) return;
    const nextTrail = [...trail, node.group.name];
    out.push({
      id: node.group.id,
      label: nextTrail.join(' / '),
      depth: node.depth,
    });
    for (const child of node.children) {
      visit(child, nextTrail);
    }
  };
  for (const root of roots) {
    visit(root, []);
  }
  // 兜底：若存在孤立节点未出现在 roots，且不在 excluded
  for (const g of sorted) {
    if (!excluded.has(g.id) && !out.some((item) => item.id === g.id) && byId.has(g.id)) {
      out.push({ id: g.id, label: g.name, depth: 0 });
    }
  }
  return out;
}

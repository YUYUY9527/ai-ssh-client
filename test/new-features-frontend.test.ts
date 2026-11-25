import { describe, it, expect } from 'vitest';
import { buildConnectionGroupTree, flattenGroupOptions } from '../src/renderer/connection/group-tree';
import {
  isCommandAllowlisted,
  evaluateAgentPolicy,
  reviewCommandWithModel,
} from '../src/renderer/agent/runtime/policy';
import { detectCodeLanguage } from '../src/renderer/transfer/code-format';
import { resolveCodeMirrorLanguage } from '../src/renderer/transfer/codemirror-languages';
import {
  extractTemplateVariables,
  renderSnippetTemplate,
} from '../src/renderer/utils/snippet-template';
import {
  createCastRecorder,
  parseCastFile,
} from '../src/renderer/session/terminal/session-recorder';
import { buildGlobalFontStack } from '../src/renderer/hooks/useTheme';

describe('Nested Connection Group Tree', () => {
  it('builds nested hierarchy, breaks cycles safely, and excludes self/descendants in options', () => {
    const groups = [
      { id: 'g1', name: 'Production', order: 0 },
      { id: 'g2', name: 'US-East', parentId: 'g1', order: 0 },
      { id: 'g3', name: 'K8s', parentId: 'g2', order: 0 },
      { id: 'c1', name: 'CycleA', parentId: 'c2', order: 1 },
      { id: 'c2', name: 'CycleB', parentId: 'c1', order: 2 },
    ];
    const { roots: tree } = buildConnectionGroupTree(groups, []);
    const prod = tree.find((n) => n.group.id === 'g1');
    expect(prod?.children[0].group.id).toBe('g2');
    expect(prod?.children[0].children[0].group.id).toBe('g3');
    // Cycle nodes must not disappear
    const allIds = new Set<string>();
    const visit = (nodes: typeof tree) => {
      for (const n of nodes) {
        allIds.add(n.group.id);
        visit(n.children);
      }
    };
    visit(tree);
    expect(allIds.size).toBe(5);

    const optionsExcludingG1 = flattenGroupOptions(groups, 'g1');
    expect(optionsExcludingG1.map((o) => o.id)).not.toContain('g1');
    expect(optionsExcludingG1.map((o) => o.id)).not.toContain('g2');
    expect(optionsExcludingG1.map((o) => o.id)).not.toContain('g3');
  });
});

describe('Agent Allowlist & Reviewer Model Policy', () => {
  it('matches exact/prefix allowlist rules while blocking critical prefix or chained bypasses', () => {
    const allowlist = { 'conn-1': ['systemctl restart nginx', 'docker logs'] };
    expect(isCommandAllowlisted('docker logs web --tail 50', 'conn-1', allowlist, 'medium')).toBe(true);
    expect(isCommandAllowlisted('docker logs web && rm -rf /tmp/x', 'conn-1', allowlist, 'medium')).toBe(false);
    expect(isCommandAllowlisted('systemctl restart nginx', 'conn-1', allowlist, 'high')).toBe(true);
    expect(isCommandAllowlisted('systemctl restart nginx', 'conn-2', allowlist, 'high')).toBe(false);

    const verdict = evaluateAgentPolicy(
      { tool: 'run_command', command: 'docker logs web', connectionId: 'conn-1', riskLevel: 'medium', write: false },
      { approveMediumRisk: true, connectionAllowlist: allowlist },
    );
    expect(verdict).toEqual({ run: true, needsApproval: false, reason: 'allowlist:approved' });
  });

  it('invokes reviewer model for high/medium risk and always rejects critical for human review', async () => {
    const criticalRes = await reviewCommandWithModel({
      reviewerProviderId: 'prov-1',
      command: 'mkfs.ext4 /dev/sdb',
      riskLevel: 'critical',
      aiChat: async () => ({ success: true, data: { content: '{"approve":true,"reason":"ok"}' } }),
    });
    expect(criticalRes.approved).toBe(false);

    const approvedRes = await reviewCommandWithModel({
      reviewerProviderId: 'prov-1',
      command: 'systemctl reload nginx',
      riskLevel: 'medium',
      userGoal: 'Reload nginx config',
      aiChat: async () => ({ success: true, data: { content: '```json\n{"approve": true, "reason": "Safe reload"}\n```' } }),
    });
    expect(approvedRes).toEqual({ approved: true, reason: 'Safe reload' });
  });
});

describe('CodeMirror Multi-Language Detection & Highlighters', () => {
  it('detects common ops/dev file types and resolves StreamLanguage extensions', () => {
    expect(detectCodeLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectCodeLanguage('deploy.sh')).toBe('shell');
    expect(detectCodeLanguage('nginx.conf')).toBe('conf');
    expect(detectCodeLanguage('app.py')).toBe('python');
    expect(detectCodeLanguage('schema.sql')).toBe('sql');
    expect(detectCodeLanguage('index.tsx')).toBe('javascript');
    expect(detectCodeLanguage('pom.xml')).toBe('xml');
    expect(detectCodeLanguage('README.md')).toBe('markdown');
    expect(detectCodeLanguage('values.yaml')).toBe('yaml');
    expect(detectCodeLanguage('package.json')).toBe('json');

    expect(resolveCodeMirrorLanguage('dockerfile')).not.toEqual([]);
    expect(resolveCodeMirrorLanguage('python')).not.toEqual([]);
    expect(resolveCodeMirrorLanguage('shell')).not.toEqual([]);
    expect(resolveCodeMirrorLanguage('text')).toEqual([]);
  });
});

describe('Quick Command Template Variables', () => {
  it('extracts deduplicated variables with default values and renders cleanly', () => {
    const template = 'docker logs --tail {{lines:200}} {{service}} && echo "checked {{service}}"';
    const vars = extractTemplateVariables(template);
    expect(vars).toEqual([
      { name: 'lines', defaultValue: '200' },
      { name: 'service', defaultValue: '' },
    ]);

    const rendered = renderSnippetTemplate(template, { service: 'api' });
    expect(rendered).toBe('docker logs --tail 200 api && echo "checked api"');
  });
});

describe('asciinema v2 .cast Session Recorder & Parser', () => {
  it('records stdout events, serializes valid asciinema v2 NDJSON, and parses back', () => {
    const recorder = createCastRecorder({ width: 100, height: 30, title: 'prod-debug' });
    recorder.recordOutput('$ ls\r\n');
    recorder.recordOutput('README.md\r\n');

    expect(recorder.getEventCount()).toBe(2);
    const castText = recorder.exportCast();
    const parsed = parseCastFile(castText);
    expect(parsed.header.version).toBe(2);
    expect(parsed.header.width).toBe(100);
    expect(parsed.header.height).toBe(30);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1][2]).toBe('README.md\r\n');
    expect(parsed.durationSec).toBeGreaterThanOrEqual(0);
  });
});

describe('Global font stack from terminal settings', () => {
  it('places CJK UI fallbacks before generic monospace to avoid SimSun fallback', () => {
    const stack = buildGlobalFontStack("'JetBrains Mono', Consolas, monospace");
    expect(stack.startsWith("'JetBrains Mono', Consolas, 'PingFang SC', 'Microsoft YaHei'")).toBe(true);
    expect(stack.endsWith('monospace')).toBe(true);
    expect(stack.indexOf("'Microsoft YaHei'")).toBeLessThan(stack.indexOf('monospace'));
  });
});

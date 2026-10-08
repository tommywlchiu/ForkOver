#!/usr/bin/env node
// Crew bearings: one-call digest of the first mate's ledger (.crew/tasks), open PRs, and worktrees,
// plus drift between them. Read-only apart from `git fetch` (skip it with --no-fetch).
// Usage: node .claude/crew/bearings.mjs [--no-fetch]
// The ledger format is documented in .claude/firstmate.md ("Task record").
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const noFetch = process.argv.includes('--no-fetch');

function run(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const err = String(error.stderr || error.message || error).trim().split('\n')[0];
    return { ok: false, out: '', err };
  }
}

const norm = (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Resolve the main checkout even when run from inside a worktree.
const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
if (!common.ok) {
  console.error(`bearings: not in a git repository (${common.err})`);
  process.exit(1);
}
const root = path.dirname(common.out);
const git = (args, cwd = root) => run('git', args, cwd);

const notes = [];
if (!noFetch) {
  const fetched = git(['fetch', 'origin', '--prune', '--quiet']);
  if (!fetched.ok) notes.push(`git fetch failed, so remote state may be stale: ${fetched.err}`);
}

const remoteDefault =
  git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/master';
const localDefault = remoteDefault.replace(/^origin\//, '');

// Unticked `- [ ]` items, joined with their indented continuation lines.
function openDecisions(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].match(/^\s*- \[ \] (.+)$/);
    if (!item) continue;
    let decision = item[1].trim();
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*- /.test(lines[i + 1])) {
      decision += ` ${lines[++i].trim()}`;
    }
    found.push(decision);
  }
  return found;
}

// Ledger.
const tasksDir = path.join(root, '.crew', 'tasks');
const tasks = existsSync(tasksDir)
  ? readdirSync(tasksDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const text = readFileSync(path.join(tasksDir, f), 'utf8');
        const fields = { id: f.replace(/\.md$/, '') };
        const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        for (const line of front ? front[1].split(/\r?\n/) : []) {
          const kv = line.match(/^([\w-]+):\s*(.*)$/);
          if (kv && kv[2].trim()) fields[kv[1]] = kv[2].trim();
        }
        fields.title = (text.match(/^# (.+)$/m) || [])[1] || '';
        fields.openDecisions = openDecisions(text);
        return fields;
      })
  : [];

// GitHub.
const prNumber = (url) => Number((String(url || '').match(/\/pull\/(\d+)/) || [])[1]) || null;
function checksSummary(rollup = []) {
  if (!rollup.length) return 'no checks';
  const state = (c) => c.conclusion || c.state || '';
  const bad = rollup.filter((c) =>
    ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
      state(c),
    ),
  );
  if (bad.length) return `checks failing (${bad.map((c) => c.name || c.context).join(', ')})`;
  const pending = rollup.filter(
    (c) => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state),
  );
  return pending.length ? 'checks pending' : 'checks passing';
}

let openPrs = [];
const prList = run(
  'gh',
  [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '50',
    '--json',
    'number,title,url,headRefName,baseRefName,isDraft,statusCheckRollup',
  ],
  root,
);
if (prList.ok) openPrs = JSON.parse(prList.out || '[]');
else notes.push(`GitHub unavailable (${prList.err}); PR state is not shown`);
const openByNumber = new Map(openPrs.map((pr) => [pr.number, pr]));

function prState(task) {
  const n = prNumber(task.pr);
  if (!n) return '';
  const open = openByNumber.get(n);
  if (open) return `PR #${n} open${open.isDraft ? ' (draft)' : ''}, ${checksSummary(open.statusCheckRollup)}`;
  if (!prList.ok) return `PR #${n}`;
  const view = run('gh', ['pr', 'view', String(n), '--json', 'state'], root);
  const state = view.ok ? JSON.parse(view.out).state : 'state unknown';
  if (['MERGED', 'CLOSED'].includes(state) && !['merged', 'closed'].includes(task.status)) {
    notes.push(`${task.id}: PR #${n} is ${state.toLowerCase()} but the record says ${task.status}`);
  }
  return `PR #${n} ${String(state).toLowerCase()}`;
}

// Worktrees.
const worktrees = [];
let current = null;
for (const line of git(['worktree', 'list', '--porcelain']).out.split(/\r?\n/)) {
  if (line.startsWith('worktree ')) {
    current = { path: line.slice(9), branch: '(detached)', locked: false };
    worktrees.push(current);
  } else if (current && line.startsWith('branch ')) {
    current.branch = line.slice(7).replace('refs/heads/', '');
  } else if (current && line.startsWith('locked')) {
    current.locked = true;
  } else if (current && line === 'prunable') {
    current.prunable = true;
  }
}
const mainWorktree = worktrees.find((w) => norm(w.path) === norm(root));
const crewWorktrees = worktrees.filter((w) => w !== mainWorktree);
for (const wt of crewWorktrees) {
  if (wt.prunable || !existsSync(wt.path)) {
    wt.summary = 'directory missing (git worktree prune clears it)';
    continue;
  }
  const dirty = git(['status', '--porcelain'], wt.path).out.split(/\r?\n/).filter(Boolean).length;
  const unpushed = Number(git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], wt.path).out || 0);
  wt.summary = `${dirty} uncommitted, ${unpushed} unpushed${wt.locked ? ', in use by a running worker' : ''}`;
}

// Output.
const today = new Date();
const stamp = `${today.toISOString().slice(0, 10)} ${today.toTimeString().slice(0, 5)}`;
const short = (ref) => git(['rev-parse', '--short', ref]).out || '?';
const out = [`Crew bearings - ${stamp}`];

const mainBranch = git(['branch', '--show-current']).out || '(detached)';
const mainDirty = git(['status', '--porcelain']).out.split(/\r?\n/).filter(Boolean).length;
const counts = git(['rev-list', '--left-right', '--count', `${localDefault}...${remoteDefault}`]).out;
const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [0, 0];
const sync =
  behind && !ahead
    ? `${behind} behind ${remoteDefault} (fast-forward: git merge --ff-only ${remoteDefault})`
    : ahead
      ? `${ahead} ahead / ${behind} behind ${remoteDefault} (local commits on ${localDefault}!)`
      : `even with ${remoteDefault}`;
out.push(
  `Main copy: on ${mainBranch}, ${mainDirty ? `${mainDirty} uncommitted` : 'clean'}; ` +
    `${localDefault} @ ${short(localDefault)} is ${sync}`,
);

const order = ['blocked', 'stalled', 'running', 'review', 'failed', 'queued', 'merged', 'closed'];
const rank = (s) => (order.includes(s) ? order.indexOf(s) : order.length);
out.push('', `Tasks (${tasks.length})`);
if (!tasks.length) out.push('  none - the ledger in .crew/tasks is empty');
for (const t of [...tasks].sort((a, b) => rank(a.status) - rank(b.status))) {
  const bits = [prState(t), t.branch, t['waiting-on'] && `waiting on: ${t['waiting-on']}`]
    .filter(Boolean)
    .join(' | ');
  out.push(`  ${t.id.padEnd(24)} ${String(t.status || '?').padEnd(8)} ${t.title}`);
  if (bits) out.push(`  ${''.padEnd(24)} ${''.padEnd(8)} ${bits}`);
  if (t.status === 'running' && t.agent) {
    out.push(`  ${''.padEnd(33)} worker ${t.agent} (gone if it was started in an earlier session)`);
  }
}

const decisions = tasks.flatMap((t) => t.openDecisions.map((d) => `  ${t.id}: ${d}`));
if (decisions.length) out.push('', 'Open decisions for the captain', ...decisions);

const ledgerPrs = new Set(tasks.map((t) => prNumber(t.pr)).filter(Boolean));
const ledgerBranches = new Set(tasks.map((t) => t.branch).filter(Boolean));
const strayPrs = openPrs.filter((pr) => !ledgerPrs.has(pr.number) && !ledgerBranches.has(pr.headRefName));
if (strayPrs.length) {
  out.push('', 'Open PRs not in the ledger');
  for (const pr of strayPrs) {
    out.push(`  #${pr.number} ${pr.title} (${pr.headRefName} -> ${pr.baseRefName}), ${checksSummary(pr.statusCheckRollup)}`);
  }
}

if (crewWorktrees.length) {
  out.push('', 'Worktrees');
  for (const wt of crewWorktrees) {
    const owner = tasks.find(
      (t) =>
        norm(t.worktree) === norm(wt.path) ||
        (t.branch && (wt.branch === t.branch || wt.branch.startsWith(`${t.branch}-r`))),
    );
    const rel = path.relative(root, wt.path) || wt.path;
    out.push(`  ${rel} [${wt.branch}] ${wt.summary}${owner ? ` - task ${owner.id}` : ' - no task record'}`);
  }
}

if (notes.length) out.push('', 'Notes', ...notes.map((n) => `  ${n}`));
console.log(out.join('\n'));

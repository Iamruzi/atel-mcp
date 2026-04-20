import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type BranchSummary = {
  branch: string;
  verdict: 'passed';
  orderId?: string;
  disputeId?: string;
  finalStatus?: string;
  currentMilestone?: number;
  detail?: string;
};

function fail(branch: string, message: string): never {
  throw new Error(`[${branch}] ${message}`);
}

function runJsonCommand(branch: string, command: string, args: string[], env: NodeJS.ProcessEnv): any {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0) {
    throw new Error(
      `[${branch}] command failed (${command} ${args.join(' ')}): ${result.stderr || result.stdout || 'unknown error'}`,
    );
  }
  const raw = String(result.stdout ?? '').trim();
  if (!raw) fail(branch, 'empty JSON output');
  const candidates = raw
    .split('\n')
    .map((_, index, lines) => lines.slice(index).join('\n'))
    .filter((chunk) => chunk.startsWith('{'));

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // Keep trying earlier JSON-looking chunks.
    }
  }
  throw new Error(`[${branch}] invalid JSON output: ${raw.slice(0, 1000)}`);
}

function execShell(branch: string, script: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync('bash', ['-lc', script], {
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });
  if (result.status !== 0) {
    throw new Error(`[${branch}] shell command failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
}

function ensureEnv(envFile: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const shellSource = `set -a && source "${envFile}" && env`;
  const result = spawnSync('bash', ['-lc', shellSource], {
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });
  if (result.status !== 0) {
    throw new Error(`failed to source env file ${envFile}: ${result.stderr || result.stdout || 'unknown error'}`);
  }

  const merged = { ...env };
  for (const line of String(result.stdout ?? '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    merged[key] = value;
  }
  return merged;
}

function setupCase(rootDir: string, envFile: string, env: NodeJS.ProcessEnv, branch: string): void {
  execShell(
    branch,
    [
      `cd "${rootDir}"`,
      './scripts/stop-release-candidate.sh || true',
      'npm run smoke:cleanup',
      `./scripts/run-release-candidate.sh "${envFile}"`,
      'sleep 2',
    ].join(' && '),
    env,
  );

  const health = runJsonCommand(branch, 'node', [path.join(rootDir, 'dist/dev/smoke-http.js')], env);
  if (health?.ok !== true) fail(branch, `healthcheck not ok: ${JSON.stringify(health)}`);
}

function summarizeHappyPath(payload: any): BranchSummary {
  const orderId = String(payload?.orderId ?? '').trim();
  const finalStatus = String(payload?.finalOrder?.Status ?? payload?.finalOrder?.status ?? '').toLowerCase();
  if (!orderId) fail('happy-path', `missing orderId: ${JSON.stringify(payload)}`);
  if (finalStatus !== 'settled') fail('happy-path', `expected settled, got ${finalStatus}`);
  return { branch: 'happy-path', verdict: 'passed', orderId, finalStatus };
}

function summarizeDispute(payload: any): BranchSummary {
  const orderId = String(payload?.orderId ?? '').trim();
  const disputeId = String(payload?.disputeId ?? '').trim();
  const finalStatus = String(payload?.order?.Status ?? payload?.order?.status ?? '').toLowerCase();
  if (!orderId || !disputeId) fail('dispute', `missing ids: ${JSON.stringify(payload)}`);
  if (String(payload?.disputeResult?.status ?? '').toLowerCase() !== 'open') {
    fail('dispute', `expected dispute open: ${JSON.stringify(payload?.disputeResult)}`);
  }
  if (finalStatus !== 'disputed') fail('dispute', `expected disputed order, got ${finalStatus}`);
  return { branch: 'dispute', verdict: 'passed', orderId, disputeId, finalStatus };
}

function summarizeArbitration(branch: string, expected: 'passed' | 'failed', payload: any): BranchSummary {
  const orderId = String(payload?.orderId ?? '').trim();
  const finalStatus = String(payload?.finalOrder?.Status ?? payload?.finalOrder?.status ?? '').toLowerCase();
  const currentMilestone = Number(payload?.finalMilestones?.currentMilestone ?? -1);
  const rejects = Array.isArray(payload?.rejects) ? payload.rejects : [];
  const finalRejectStatus = String(rejects.at(-1)?.status ?? '').toLowerCase();

  if (!orderId) fail(branch, `missing orderId: ${JSON.stringify(payload)}`);
  if (expected === 'passed') {
    if (finalRejectStatus !== 'arbitration_passed') {
      fail(branch, `expected arbitration_passed, got ${finalRejectStatus}`);
    }
    if (finalStatus !== 'executing') fail(branch, `expected executing, got ${finalStatus}`);
    if (currentMilestone !== 1) fail(branch, `expected currentMilestone=1, got ${currentMilestone}`);
    return {
      branch,
      verdict: 'passed',
      orderId,
      finalStatus,
      currentMilestone,
      detail: 'arbitration passed and milestone advanced',
    };
  }

  if (finalRejectStatus !== 'arbitration_failed') {
    fail(branch, `expected arbitration_failed, got ${finalRejectStatus}`);
  }
  if (finalStatus !== 'cancelled') fail(branch, `expected cancelled, got ${finalStatus}`);
  return {
    branch,
    verdict: 'passed',
    orderId,
    finalStatus,
    currentMilestone,
    detail: 'arbitration failed and order cancelled',
  };
}

function main() {
  const rootDir = process.cwd();
  const envFile = process.argv[2] ?? path.join(rootDir, '.env.release.local');
  const mergedEnv = ensureEnv(envFile);
  const workDir = path.join(rootDir, '.runtime', `release-summary-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const summaries: BranchSummary[] = [];

  try {
    const cases: Array<{
      branch: string;
      env?: Record<string, string>;
      script: string;
      summarize: (payload: any) => BranchSummary;
    }> = [
      {
        branch: 'happy-path',
        script: path.join(rootDir, 'dist/dev/smoke-happy-path.js'),
        summarize: summarizeHappyPath,
      },
      {
        branch: 'dispute',
        script: path.join(rootDir, 'dist/dev/smoke-dispute.js'),
        summarize: summarizeDispute,
      },
      {
        branch: 'auto-arbitration-passed',
        env: { ATEL_MCP_ARBITRATION_EXPECTED: 'passed' },
        script: path.join(rootDir, 'dist/dev/smoke-auto-arbitration.js'),
        summarize: (payload) => summarizeArbitration('auto-arbitration-passed', 'passed', payload),
      },
      {
        branch: 'auto-arbitration-failed',
        env: { ATEL_MCP_ARBITRATION_EXPECTED: 'failed' },
        script: path.join(rootDir, 'dist/dev/smoke-auto-arbitration.js'),
        summarize: (payload) => summarizeArbitration('auto-arbitration-failed', 'failed', payload),
      },
    ];

    for (const entry of cases) {
      const branchEnv = { ...mergedEnv, ...entry.env };
      setupCase(rootDir, envFile, branchEnv, entry.branch);
      const payload = runJsonCommand(entry.branch, 'node', [entry.script], branchEnv);
      const summary = entry.summarize(payload);
      summaries.push(summary);
      writeFileSync(path.join(workDir, `${entry.branch}.json`), JSON.stringify(payload, null, 2), 'utf8');
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          cases: summaries,
          artifactsDir: workDir,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, message, artifactsDir: workDir }, null, 2));
    process.exitCode = 1;
  }
}

main();

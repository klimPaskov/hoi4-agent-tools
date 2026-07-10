import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  containsFatalLocalTestOutput,
  evaluateLocalTestRun,
  localVitestArguments,
  type LocalTestObservation,
  type LocalTestReport,
} from './testing/local-test-harness.js';

// Project validation harness only; this file is not a packaged product command.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-local-test-'));
const reportPath = path.join(temporary, 'report.json');
const vitestCli = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

try {
  const childResult = await new Promise<{
    exitCode: number | null;
    fatalOutputDetected: boolean;
    output: string;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, ...localVitestArguments()], {
      cwd: root,
      env: { ...process.env, HOI4_LOCAL_TEST_REPORT: reportPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let fatalOutputDetected = false;
    let output = '';
    let scanTail = '';
    const append = (chunk: Buffer, target: NodeJS.WriteStream): void => {
      const text = chunk.toString('utf8');
      const scan = `${scanTail}${text}`;
      fatalOutputDetected ||= containsFatalLocalTestOutput(scan);
      scanTail = scan.slice(-512);
      output = `${output}${text}`.slice(-1_048_576);
      target.write(text);
    };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, process.stdout));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, process.stderr));
    child.once('error', reject);
    child.once('close', (exitCode, signal) =>
      resolve({ exitCode, fatalOutputDetected, output, signal }),
    );
  });

  const observation: LocalTestObservation = { ...childResult };
  try {
    observation.report = JSON.parse(await readFile(reportPath, 'utf8')) as LocalTestReport;
  } catch (error) {
    observation.reportError = `Unable to read the local-test report: ${error instanceof Error ? error.message : String(error)}`;
  }
  const evaluation = evaluateLocalTestRun(observation);
  if (evaluation.issues.length > 0) {
    process.stderr.write(
      `${evaluation.issues.map((issue) => `[local-test-harness] ${issue}`).join('\n')}\n`,
    );
  } else {
    process.stderr.write(
      `[local-test-harness] Completed ${observation.report?.completed.length ?? 0} local tests without unhandled worker errors.\n`,
    );
  }
  process.exitCode = evaluation.exitCode;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
